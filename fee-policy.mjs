// GLORY ARENA 3% fee policy: informational calculation only.
// Never withdraw, debit, escrow, transfer, or credit member funds here.
export const PLATFORM_FEE_BPS=300;
export const FEE_POLICY_VERSION='2026-11-26-3pct-v1';
export function projectPrize(stakeMicro,stakeOtherMicro=stakeMicro,feeBps=PLATFORM_FEE_BPS){
  const a=BigInt(stakeMicro),b=BigInt(stakeOtherMicro);
  if(a<=0n||b<=0n)throw new RangeError('INVALID_STAKE');
  if(!Number.isSafeInteger(feeBps)||feeBps<0||feeBps>10000)throw new RangeError('INVALID_FEE');
  const pool=a+b,fee=pool*BigInt(feeBps)/10000n;
  return {stakeA:a,stakeB:b,pool,fee,winnerPayout:pool-fee,feeBps,policyVersion:FEE_POLICY_VERSION,previewOnly:true};
}
