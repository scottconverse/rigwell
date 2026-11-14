const port=Number(process.env.PORT||8080);export const loadConfig=()=>({port,debug:!!process.env.DEBUG});
