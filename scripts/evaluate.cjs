// Live replay evaluation is explicit; it never uses the player's world as test data.
const { app, safeStorage, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { openStore } = require('../src/store.cjs');
const { analyze } = require('../src/provider.cjs');

app.setName('AI Game Companion');
const label = process.argv.includes('after') ? 'after' : 'before';
const onlyLearn=process.argv.includes('learn');
if (!process.argv.includes('--live')) { console.log('실제 요청 평가: npm run evaluate -- --live before 또는 after'); app.exit(0); }
if (!app.requestSingleInstanceLock()) { console.error('평가 전에 동료 앱을 닫아주세요.'); app.exit(1); }
app.whenReady().then(async () => {
  let store;
  let model;
  const reports = [];
  try {
    const directory = app.getPath('userData'), settings = JSON.parse(fs.readFileSync(path.join(directory,'settings.json'),'utf8'));
    if (!settings.analysisConsent || !settings.model || !safeStorage.isEncryptionAvailable()) throw Error('AI 전송 동의와 연결된 모델이 필요해요.');
    model=settings.model;
    const key = safeStorage.decryptString(fs.readFileSync(path.join(directory,'key.enc')));
    store = openStore(directory);
    const file=path.resolve(__dirname,'../.local/frame-28.jpg'), size=nativeImage.createFromPath(file).getSize();
    if (!size.width) throw Error('첨부 영상 00:28의 원본 프레임이 필요해요.');
    const evidence=[{id:'evaluation-video-28',source:'video',created_at:new Date().toISOString(),payload:{...size,videoTime:28,capturedAt:null},file}];
    const world={id:'evaluation-only',name:'홉 운송 리플레이 평가',game:'anno1800',goal:'홉 섬에서 메인섬으로 홉을 운송해 맥주 생산하기',state:{scenario:'anno-hops',step:1,status:'proposed',inputs:{}},revision:1};
    const cases=[
      {id:'learn',question:'홉 섬에서 맥주용 홉을 키우려는데 자본이나 물품을 메인섬에서 어떻게 가져오는지 몰라. 무역로 설정 방법, 양쪽에서 뭘 옮길지, 배가 몇 척 필요한지 알고 싶어. 한 단계씩 같이 해보자.',evidence,world},
      {id:'panel',question:'영상의 무역 옵션 선택에서 뭘 눌러야 홉을 메인섬으로 보낼 수 있어? 실제 화면에서 확인되는 부분만 이미지에 짚어줘.',evidence,world},
      {id:'fleet',question:'화면에 홉이 7/75로 보이는데, 배 한 척이면 충분하다는 뜻이야?',evidence,world},
      {id:'casual',question:'오늘은 그냥 구경하면서 천천히 하자.',evidence:[],world:{...world,game:'Factorio',goal:'',state:{scenario:null,step:0,status:'proposed',inputs:{}}}}
    ];
    for(const sample of onlyLearn?cases.slice(0,1):cases){
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date());
      const startOfDay=new Date(`${today}T00:00:00+09:00`).toISOString();
      if(store.usageSince(startOfDay).length>=settings.maxRequests) throw Error('앱의 오늘 요청 한도에 도달했어요.');
      const usageId=store.reserveUsage(settings.model,{status:'sent',type:'evaluation',case:sample.id});
      const started=Date.now();
      try{
        const result=await analyze({key,model:settings.model,...sample,memories:[],profile:settings.profile,signal:AbortSignal.timeout(60000)});
        store.updateUsage(usageId,{status:'completed',type:'evaluation',case:sample.id,usage:result.usage,providerId:result.providerId});
        reports.push({case:sample.id,question:sample.question,milliseconds:Date.now()-started,...result});
        console.log(`${label}: ${sample.id} 완료 (${Date.now()-started}ms)`);
      }catch(error){store.updateUsage(usageId,{status:'unknown',type:'evaluation',case:sample.id}); throw error;}
    }
  }catch(error){console.error('EVALUATION FAILED',String(error.message).replace(/sk-or-[a-zA-Z0-9-]+/g,'[redacted]')); process.exitCode=1;}
  finally{
    const directory=path.resolve(__dirname,'../.local'); fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,`evaluation-${label}${onlyLearn?'-learn':''}.json`),JSON.stringify({model,reports},null,2));
    store?.close(); app.exit(process.exitCode||0);
  }
});
