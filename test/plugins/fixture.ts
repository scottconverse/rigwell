import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function pluginFixture(root: string, version = "1.0.0") {
  const put = (p: string, text: string) => { const file = join(root, p); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
  put("rigwell-plugin.json", JSON.stringify({ name: "fixture-plugin", version, description: "Fixture contributions", skills: "skills", agents: "agents", commands: "commands", hooks: "hooks.json", mcp: "mcp.json", automationTemplates: "templates.json" }));
  put("skills/fixture-skill/SKILL.md", '---\nname: fixture-skill\ndescription: Read the fixture contribution instructions.\n---\nFollow the fixture instructions.\n');
  put("agents/helper.md", '---\nname: fixture-helper\ndescription: A fixture helper\n---\nReport the fixture result.\n');
  put("commands/fixture-command.md", '---\ndescription: Fixture command\n---\nInspect fixture $ARGUMENTS.\n');
  put("hook.cjs", "require('node:fs').writeFileSync('plugin-hook.txt','approved-hook');console.log('{}');");
  put("hooks.json", JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: `"${process.execPath.replaceAll("\\", "/")}" -e "require(process.env.RIGWELL_PLUGIN_ROOT + '/hook.cjs')"` }] }] }));
  put("server.cjs", `let text='';process.stdin.on('data',chunk=>{text+=chunk;let i;while((i=text.indexOf('\\n'))>=0){const line=text.slice(0,i);text=text.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Fixture echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'plugin-echo:'+m.params.arguments.text}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}))}});`);
  put("mcp.json", JSON.stringify({ fixture: { command: process.execPath, args: ["-e", "require(process.env.RIGWELL_PLUGIN_ROOT + '/server.cjs')"], env: { FAKE_PLUGIN_FLAG: "fixture" } } }));
  put("templates.json", JSON.stringify([{ id: "check", name: "Fixture check", description: "Check a fixture", category: "testing", schedule: "daily", parameters: [{ key: "target", label: "Target", description: "Fixture target", default: "fixture" }], instructions: "Check {{target}} without changes.", autonomy: "low" }]));
  return root;
}
