import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { chatJson } from '../src/llm/adapter';
// 加载真实 scene.actor 模板的文件内容(带禁令)
const tpl = readFileSync('src/prompt/templates/scene.actor.txt','utf8');
const db = new DatabaseSync('data/infinite-date.sqlite',{readOnly:true});
const row = db.prepare('SELECT messages_json FROM llm_call_log WHERE id=4321').get() as any;
const msgs = JSON.parse(row.messages_json) as any[];
// 用真实模板替换 system
const SYSTEM = tpl
  .replace('{{character_name}}','林溯').replace('{{player_name}}','星落')
  .replace('{{character_card}}', msgs[0].content.split('【对方是谁】')[0].split('【你的性格与人设】')[1]||'')
  .replace('{{player_profile}}','')
  .replace(new RegExp('\\{\\{player_name\\}\\}','g'),'星落').replace(new RegExp('\\{\\{character_name\\}\\}','g'),'林溯');
msgs[0] = { role:'system', content: SYSTEM };
const res = await chatJson<any>(msgs, { schema:{type:'object',properties:{texts:{type:'array',items:{type:'string'}},player_description:{type:'string'},internal:{type:'string'},internal_notable:{type:'boolean'}},required:['texts']}, temperature:0.9, maxTokens:800, maxRetries:2, callType:'ab-verify-live' });
console.log('台词:', (res?.texts||[]).join('｜').slice(0,90));
console.log('心声:', (res?.internal||'').slice(0,90));
console.log('台词含该死:', /该死/.test((res?.texts||[]).join('')));
console.log('心声含该死:', /该死/.test(res?.internal||''));
