import { chatJson } from '../llm/adapter';
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/output/infinite-date-v2/apps/server/data/infinite-date.sqlite');
const nestedSchema:any={type:'object',properties:{segments:{type:'array',items:{type:'array',items:{type:'object',properties:{type:{type:'string',enum:['action','speech']},content:{type:'string'}},required:['type','content']}}},player_description:{type:'string'},internal:{type:'string'},internal_notable:{type:'boolean'}},required:['segments']};
function normNested(o:any){ if(!Array.isArray(o?.segments)||!o.segments.length)return null; for(const b of o.segments){ if(!Array.isArray(b)||!b.length)return null; for(const s of b){ if(!s||typeof s!=='object'||(s.type!=='action'&&s.type!=='speech'))return null; if(typeof s.content!=='string'||!s.content.trim())return null; } } return {ok:true}; }
// 用生产翻车那条输入 3805 (in=9185)
const row=db.prepare("SELECT messages_json FROM llm_call_log WHERE id=3805").get() as any;
const msgs=JSON.parse(row.messages_json) as any[];
console.log('重放生产翻车输入 3805 (in ≈', msgs.reduce((a:number,m:any)=>a+String(m.content||'').length,0),'字符, tokens_in 约9185) 嵌套 ×5');
(async()=>{
  let ok=0,fail=0;
  for(let i=0;i<5;i++){
    const r=await chatJson<any>(msgs as any,{schema:nestedSchema,temperature:0.85,maxTokens:4096,maxRetries:2,normalize:normNested,callType:'ab-replay-3805'});
    if(r) ok++; else { console.log(`  [#${i}] ✗ null (3次重试失败)`); fail++; }
  }
  console.log(`结果: 成功${ok}/5 失败${fail}/5`);
})();
