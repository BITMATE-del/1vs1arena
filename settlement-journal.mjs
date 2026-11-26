import {createHash} from 'node:crypto';
import {FEE_POLICY_VERSION,PLATFORM_FEE_BPS,projectPrize} from './fee-policy.mjs';

// Append-only non-monetary settlement decision journal. No balance mutations.
export function classifyMatch(m){
 if(!m||!['finished','cancelled'].includes(m.state))return null;
 if(!Number.isSafeInteger(Number(m.id))||Number(m.id)<=0)throw Error('INVALID_MATCH');
 if(m.state==='cancelled')return {decision:'refund_both',reason:'cancelled_unfinished',feeBps:0,winner:null};
 if(!Number.isSafeInteger(Number(m.a))||!Number.isSafeInteger(Number(m.b)))throw Error('INVALID_SCORES');
 if(Number(m.a)===Number(m.b))return {decision:'refund_both',reason:'draw',feeBps:0,winner:null};
 return {decision:'winner_preview',reason:'decisive_finish',feeBps:PLATFORM_FEE_BPS,winner:Number(m.a)>Number(m.b)?Number(m.owner):Number(m.guest)};
}
export function refundPreview(a,b){
 const x=BigInt(a),y=BigInt(b);
 if(x<0n||y<0n)throw RangeError('INVALID_STAKES');
 return {refundA:x,refundB:y,fee:0n,reason:'draw_or_cancellation',previewOnly:true};
}
export function matchSettlementPreview(m,a,b){
 const decision=classifyMatch(m);
 if(!decision)return null;
 if(decision.decision==='refund_both')return {...decision,...refundPreview(a,b)};
 return {...decision,...projectPrize(a,b)};
}
export function createSettlementJournal(db,options={}){
 db.exec("CREATE TABLE IF NOT EXISTS match_settlement_decisions(match_id INTEGER PRIMARY KEY,created INTEGER NOT NULL,match_state TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,fee_bps INTEGER NOT NULL,winner_id INTEGER,snapshot_json TEXT NOT NULL,policy_version TEXT NOT NULL,digest_sha256 TEXT NOT NULL,execution_state TEXT NOT NULL DEFAULT 'preview_only' CHECK(execution_state='preview_only'));CREATE TABLE IF NOT EXISTS match_settlement_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
 db.exec("CREATE TRIGGER IF NOT EXISTS settlement_decisions_no_update BEFORE UPDATE ON match_settlement_decisions BEGIN SELECT RAISE(ABORT,'SETTLEMENT_AUDIT_IMMUTABLE');END");
 db.exec("CREATE TRIGGER IF NOT EXISTS settlement_decisions_no_delete BEFORE DELETE ON match_settlement_decisions BEGIN SELECT RAISE(ABORT,'SETTLEMENT_AUDIT_IMMUTABLE');END");
 // Snapshot cutoff prevents retroactively treating historical free games as fee bearing.
 const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
 const time=options.now||Date.now;
 if(!one("SELECT value FROM match_settlement_meta WHERE key='starting_match_id'")){
   const max=one('SELECT COALESCE(MAX(id),0) AS id FROM matches').id;
   run("INSERT OR IGNORE INTO match_settlement_meta(key,value) VALUES('starting_match_id',?)",String(max));
 }
 const cutoff=Number(one("SELECT value FROM match_settlement_meta WHERE key='starting_match_id'").value);
 function record(m){
   if(!m||Number(m.id)<=cutoff)return {status:'historical_skipped'};
   const decision=classifyMatch(m);
   if(!decision)return {status:'not_terminal'};
   const prior=one('SELECT * FROM match_settlement_decisions WHERE match_id=?',m.id);
   if(prior)return {status:'already_recorded',entry:prior};
   const snapshot={id:Number(m.id),chat:Number(m.chat),owner:Number(m.owner),guest:m.guest==null?null:Number(m.guest),game:m.game,mode:m.mode,rounds:Number(m.rounds),state:m.state,a:Number(m.a),b:Number(m.b)};
   if(decision.decision==='winner_preview'&&(!Number.isSafeInteger(decision.winner)||decision.winner<=0))throw Error('WINNER_MISSING');
   const snapshotJson=JSON.stringify(snapshot);
   const fields=JSON.stringify({snapshot,decision,policyVersion:FEE_POLICY_VERSION,executionState:'preview_only'});
   const digest=createHash('sha256').update(fields).digest('hex');
   // UNIQUE match_id ensures retries/replayed Telegram updates are idempotent.
   const result=run("INSERT OR IGNORE INTO match_settlement_decisions(match_id,created,match_state,decision,reason,fee_bps,winner_id,snapshot_json,policy_version,digest_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)",
     snapshot.id,time(),snapshot.state,decision.decision,decision.reason,decision.feeBps,decision.winner,snapshotJson,FEE_POLICY_VERSION,digest);
   return {status:result.changes?'recorded':'already_recorded',entry:one('SELECT * FROM match_settlement_decisions WHERE match_id=?',m.id)};
 }
 function reconcile(limit=50){
   const pending=all("SELECT m.* FROM matches m LEFT JOIN match_settlement_decisions d ON d.match_id=m.id WHERE m.id>? AND m.state IN ('finished','cancelled') AND d.match_id IS NULL ORDER BY m.id LIMIT ?",cutoff,Math.max(1,Math.min(100,limit)));
   let recorded=0,errors=0;
   for(const m of pending){try{if(record(m).status==='recorded')recorded++;}catch(e){errors++;console.warn('Settlement audit record failed:',String(e.message||e).slice(0,100));}}
   return {recorded,errors};
 }
 function entries(limit=50){return all('SELECT * FROM match_settlement_decisions ORDER BY match_id DESC LIMIT ?',Math.max(1,Math.min(limit,100)));}
 function verify(entry){
   const snapshot=JSON.parse(entry.snapshot_json);
   const decision={decision:entry.decision,reason:entry.reason,feeBps:entry.fee_bps,winner:entry.winner_id};
   return entry.digest_sha256===createHash('sha256').update(JSON.stringify({snapshot,decision,policyVersion:entry.policy_version,executionState:'preview_only'})).digest('hex');
 }
 function summary(){return {cutoff,total:one('SELECT COUNT(*) n FROM match_settlement_decisions').n,refunds:one("SELECT COUNT(*) n FROM match_settlement_decisions WHERE decision='refund_both'").n,winners:one("SELECT COUNT(*) n FROM match_settlement_decisions WHERE decision='winner_preview'").n};}
 return {record,reconcile,entries,verify,summary};
}
