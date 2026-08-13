import * as adapter from '../llm/adapter';
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/output/infinite-date-v2/apps/server/data/infinite-date.sqlite');

// 收集多个不同长度的真实长 actor 输入(来自改造期间+回滚后的真实调用)
const ids=[3800,3805,3811,3845,3855,3863,3869]; // in 5454~10660
const pool:{in:number,msgs:any[],inTok:number}[]=[];
for(const id of ids){
  const r=db.prepare("SELECT messages_json, tokens_in FROM llm_call_log WHERE id=?").get(id) as any;
  if(!r)continue;
  pool.push({in:id,msgs:JSON.parse(r.messages_json),inTok:r.tokens_in});
}
console.log('输入池:', pool.map(p=>`${p.in}(in${p.inTok})`).join(', '));

// 2层 schema + minItems:1 (已验证不卡死)
const SZ:any={type:'object',properties:{
  lines:{type:'array',minItems:1,items:{type:'object',properties:{
    text:{type:'string'},is_action:{type:'boolean'}
  },required:['text','is_action']}},
  player_description:{type:'string'}
},required:['lines']};
// normalize: 校验 + 把 lines 拼回 "（动作）话" 展示字符串, 模拟生产 normalize 的拼接层
function normalize(o:any): string[]|null{
  if(!Array.isArray(o?.lines)||!o.lines.length)return null;
  const texts:string[]=[]; let cur='';
  for(const it of o.lines){
    if(typeof it.text!=='string'||!it.text.trim())return null;
    if(typeof it.is_action!=='boolean')return null;
    const t=it.text.trim();
    // 用 bubble 边界: 这里简化为一拍 = 全部 lines 拼成一条(生产再按需分气泡)
    if(it.is_action) cur+=`（${t}）`; else cur+=t;
  }
  if(!cur.trim())return null;
  return [cur];
}

const ITER=Number(process.env.N||3); // 每条输入跑N次 → 满载
async function runPool(guided:boolean){
  let ok=0,fail=0,total=0; const fails:string[]=[];
  for(const p of pool){
    for(let i=0;i<ITER;i++){
      total++;
      let res:any;
      if(guided){
        res=await adapter.chat(p.msgs as any,{temperature:0.85,maxTokens:4096,guidedJson:SZ,callType:'ab-full-g'});
        const o=adapter.tryParseJsonReply(String(res.content||''));
        if(o&&normalize(o))ok++; else{fail++;fails.push(`${p.in}#${i}`);}
      } else {
        res=await adapter.chat(p.msgs as any,{temperature:0.85,maxTokens:4096,callType:'ab-full-ng'});
        const o=adapter.tryParseJsonReply(String(res.content||''));
        if(o&&normalize(o))ok++; else{fail++;fails.push(`${p.in}#${i}`);}
      }
    }
  }
  return {ok,fail,total,fails};
}
(async()=>{
  console.log(`\n=== 满载: ${pool.length}组真实输入(5454~10660tok)×${ITER}次 = ${pool.length*ITER}次/分支 ===`);
  console.log('\n[分支A] guidedJson ON (生产路径) + 2层schema:');
  const A=await runPool(true);
  console.log(`  成功${A.ok}/${A.total} 失败${A.fail} ${A.fails.length?'失败于:'+A.fails.join(','):''}`);
  console.log('\n[分支B] guidedJson OFF (自由输出→parse):');
  const B=await runPool(false);
  console.log(`  成功${B.ok}/${B.total} 失败${B.fail} ${B.fails.length?'失败于:'+B.fails.join(','):''}`);
})();
