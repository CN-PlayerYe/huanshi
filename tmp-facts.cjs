const { AgentEngine } = require("./dist-electron/server/agent/engine.js");
const { defaultAgents } = require("./dist-electron/server/agents.js");
const { MemoryService } = require("./dist-electron/server/memory/service.js");
const { Db } = require("./dist-electron/server/storage/index.js");
const { createProvider } = require("./dist-electron/server/providers/index.js");
const os=require("os"),path=require("path"),fs=require("fs");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"facttest-"));
(async () => {
  const db=new Db(tmp);
  const memory=new MemoryService({mode:"local",localEnabled:true},tmp);
  const agent={...defaultAgents()[0],isolatedMemory:true};
  db.saveAgent(agent);
  const engine=new AgentEngine({db,memory,registry:{list:()=>[]},dataDir:tmp,getSettings:()=>({providers:{},activeProvider:"",mainModel:"",toolWhitelistDir:tmp})});
  const session=db.createSession("facts",agent.id);
  for(let i=0;i<22;i++){db.appendMessage({id:"u"+i,sessionId:session.id,role:"user",parts:[{type:"text",text:"我们聊了点什么"+i}],createdAt:Date.now()+i});db.appendMessage({id:"a"+i,sessionId:session.id,role:"assistant",parts:[{type:"text",text:"嗯记下了"+i}],createdAt:Date.now()+i});}
  console.log("消息数:",db.getMessages(session.id).length);
  // 直接调 generateFacts(用假 provider 返回文本)
  const fakeProvider={chatStream:async function*(){yield{delta:"主人喜欢火锅"};yield{delta:"约定周日爬山"};}};
  const { generateFacts } = require("./dist-electron/server/agent/engine.js");
  // 手动触发一次完整沉淀链路
  const facts = await generateFacts({kind:"openai",baseUrl:"http://127.0.0.1:9",apiKey:"x",model:"m"}, db.getMessages(session.id).slice(-40), tmp);
  console.log("generateFacts 返回:",JSON.stringify(facts));
  const lines=facts.split("\n").map(l=>l.trim()).filter(l=>l&&l!=="无"&&l!=="无。");
  console.log("事实行:",lines.length);
  for(const f of lines) await memory.retain(f.slice(0,500),"fact",agent.id);
  const all=await memory.list(agent.id);
  console.log("facts 库:",all.filter(m=>m.kind==="fact").length,"条");
  process.exit(0);
})();
