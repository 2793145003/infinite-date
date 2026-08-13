import { DatabaseSync } from 'node:sqlite';
import * as adapter from '../llm/adapter';
const db=new DatabaseSync('/output/infinite-date-v2/apps/server/data/infinite-date.sqlite');
function get(id:number){ const r=db.prepare("SELECT messages_json FROM llm_call_log WHERE id=?").get(id) as any; return JSON.parse(r.messages_json) as any[]; }
const msgs3800=get(3800), msgs3805=get(3805);
const nestedSchema:any={type:'object',properties:{segments:{type:'array',items:{type:'array',items:{type:'object',properties:{type:{type:'string',enum:['action','speech']},content:{type:'string'}},required:['type','content']}}},player_description:{type:'string'},internal:{type:'string'},internal_notable:{type:'boolean'}},required:['segments']};
function norm(o:any){ if(!Array.isArray(o?.segments)||!o.segments.length)return null; for(const b of o.segments){ if(!Array.isArray(b)||!b.length)return null; for(const s of b){ if(!s||typeof s!=='object'||(s.type!=='action'&&s.type!=='speech'))return null; if(typeof s.content!=='string'||!s.content.trim())return null; } } return {ok:true}; }
async function runOne(label:string, m:any[], guided:boolean){
  let res:any;
  try{
    if(guided) res=await adapter.chatJson<any>(m as any,{schema:nestedSchema,temperature:0.85,maxTokens:4096,maxRetries:0,normalize:norm,callType:'ab-ctl-g'});
    else {
      // 无 guided: 直接 chat, 手动 parse + normalize
      const r=await adapter.chat(m as any,{temperature:0.85,maxTokens:4096,callType:'ab-ctl-ng'});
      const obj=adapter.tryParseJsonReply(r.content);
      res = obj? norm(obj) : null;
    }
  }catch(e){ return `${e}`; }
  return res? 'OK' : 'NULL';
}
(async()=>{
  console.log('=== 3800(干净首次) [[guided ON]] ×4 ===');
  for(let i=0;i<4;i++) console.log(`  #${i}: ${await runOne('3800',msgs3800,true)}`);
  console.log('=== 3805(retry叠加历史) guided ON ×4 ===');
  for(let i=0;i<4;i++) console.log(`  #${i}: ${await runOne('3805',msgs3805,true)}`);
  console.log('=== 3805 同输入 但 guided OFF(自由输出→parse) ×4 ===');
  for(let i=0;i<4;i++) console.log(`  #${i}: ${await runOne('3805ng',msgs3805,false)}`);
})();
