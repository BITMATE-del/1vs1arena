import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {baccaratHand,seotdaHand,compareHands,isSpecialMode,createSpecialDiceEngine} from './special-rules.mjs';

assert.equal(baccaratHand(6,3).score,9);
assert.equal(baccaratHand(5,6).score,1);
assert.equal(baccaratHand(4,6).score,0);
assert.equal(compareHands('baccarat',[6,3],[5,6]).winner,1);
assert.equal(compareHands('baccarat',[1,5],[2,4]).winner,0);
assert.equal(seotdaHand(1,1).label,'1땡');
assert(seotdaHand(1,1).rank>seotdaHand(1,2).rank);
assert(seotdaHand(6,6).rank>seotdaHand(5,5).rank);
assert.equal(seotdaHand(2,1).label,'알리');
assert.equal(seotdaHand(4,1).label,'독사');
assert.equal(seotdaHand(6,4).label,'세륙');
assert(seotdaHand(1,2).rank>seotdaHand(1,4).rank);
assert(seotdaHand(1,4).rank>seotdaHand(4,6).rank);
assert.equal(seotdaHand(2,3).label,'5끗');
assert.equal(seotdaHand(4,6).label,'세륙');
assert.equal(seotdaHand(5,6).label,'1끗');
assert.equal(compareHands('seotda',[2,1],[6,6]).winner,-1);
assert.equal(compareHands('seotda',[1,4],[4,6]).winner,1);
assert.equal(compareHands('seotda',[3,5],[6,2]).winner,0);
assert(isSpecialMode('baccarat')&&isSpecialMode('seotda')&&!isSpecialMode('wins'));

const db=new DatabaseSync(':memory:');
db.exec("CREATE TABLE matches(id INTEGER PRIMARY KEY,chat INTEGER,owner INTEGER,guest INTEGER,game TEXT,mode TEXT,rounds INTEGER,state TEXT,turn INTEGER,round INTEGER DEFAULT 1,a INTEGER DEFAULT 0,b INTEGER DEFAULT 0);CREATE TABLE rolls(chat INTEGER,message INTEGER,match INTEGER,round INTEGER,player INTEGER,value INTEGER,PRIMARY KEY(chat,message),UNIQUE(match,round,player))");
const eng=createSpecialDiceEngine(db);
function play(mode,rounds,hands,id){
  db.prepare("INSERT INTO matches(id,chat,owner,guest,game,mode,rounds,state,turn) VALUES(?,?,?,?,'🎲',?,?,'active',?)").run(id,-100000,id*10+1,id*10+2,mode,rounds,id*10+1);
  const users=[id*10+1,id*10+2,id*10+1,id*10+2];
  let msg=1000+id*100,result;
  for(let j=0;j<hands.length;j++){
    const rolls=[hands[j][0][0],hands[j][1][0],hands[j][0][1],hands[j][1][1]];
    for(let i=0;i<4;i++){
      const m=db.prepare("SELECT * FROM matches WHERE id=?").get(id);
      assert.equal(m.turn,users[i],'turn matches expected 4-step order');
      assert.equal(eng.getStage(m).player,users[i]);
      result=eng.accept(m,{chat:m.chat,user:users[i],value:rolls[i],message:msg++});
      assert(result.accepted);
      if(i<3){
        assert.equal(result.done,false);
        const reject=eng.accept(db.prepare('SELECT * FROM matches WHERE id=?').get(id),{chat:m.chat,user:users[i],value:rolls[i],message:msg++});
        assert.equal(reject.accepted,false,'cannot roll out of turn');
      }
    }
    assert.equal(result.done,j===hands.length-1);
  }
  const fin=db.prepare('SELECT * FROM matches WHERE id=?').get(id);
  assert.equal(fin.state,'finished');
  return fin;
}
const baccarat=play('baccarat',3,[
  [[6,3],[5,6]], // A 9 vs B 1
  [[1,5],[2,4]], // tie 6 / 6, nobody scores
  [[1,2],[3,6]], // A 3 vs B 9
],1);
assert.equal(baccarat.a,1);assert.equal(baccarat.b,1);
assert.equal(db.prepare('SELECT COUNT(*) n FROM rolls WHERE match=1').get().n,6);
assert.equal(db.prepare('SELECT COUNT(*) n FROM special_second_rolls WHERE match=1').get().n,6);
const seotda=play('seotda',3,[
  [[1,2],[1,4]], // Ali > Doksa
  [[2,2],[6,6]], // 6ddang > 2ddang
  [[4,6],[4,6]], // ties
],2);
assert.equal(seotda.a,1);assert.equal(seotda.b,1);
assert.throws(()=>seotdaHand(7,1),/INVALID_SPECIAL_DIE/);
assert.throws(()=>baccaratHand(0,1),/INVALID_SPECIAL_DIE/);
console.log('GLORY ARENA baccarat/seotda two-roll and turn-order tests PASS');
