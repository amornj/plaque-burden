(() => {
  const runs = [];
  let runSequence=0,segmentSequence=0;
  const allCards=()=>runs.flatMap(run=>run.segments);
  let activeStudy=null,currentExamId=null,currentExamDraft=null,hydrating=true,dirty=false,changeVersion=0,saveTask=null,saveScheduled=false,navigationBusy=false,persistRequested=false,saveFailure=null,recoveryPending=false;
  let currentView='exam',examScroll=0,recordScroll=0,recordEntries=[],recordsVersion=0;
  const knownPhotos=new Set(),store=window.StudyStore;
  let feedbackTimer;
  const studyId=()=>crypto.randomUUID();
  const writerId=studyId(),journalPrefix='plaque-burden-pending:';
  const studyDate=iso=>new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short'}).format(new Date(iso));
  function saveFeedback(state,message,error=null){
    if(state==='saved'&&allCards().some(({s})=>s.photoLoading)){state='saving';message='Preparing photo for saving…';}
    clearTimeout(feedbackTimer);
    const feedback=document.querySelector('.save-feedback'),quiet=['idle','saved'].includes(state);feedback.dataset.state=state;document.querySelector('#save-status').textContent=quiet?'':message;
    if(quiet)feedback.hidden=true;else if(state==='saving'&&feedback.hidden)feedbackTimer=setTimeout(()=>{feedback.hidden=false;},350);else feedback.hidden=false;
    document.querySelector('#retry-save').hidden=state!=='error'||['conflict','deleted'].includes(error?.code);
    document.querySelector('#reload-study').hidden=!['conflict','deleted'].includes(error?.code);
  }
  function studyBanner(){
    const historical=activeStudy?.id!==currentExamId;
    document.querySelector('.study-toolbar').hidden=!historical;
    document.querySelector('#menu-exam').hidden=!historical||currentView==='records';
    document.querySelector('#menu-records').hidden=currentView==='records';
  }
  function showPatientData(open){
    const input=document.querySelector('#patient-data'),button=document.querySelector('#patient-data-toggle'),hasData=!!input.value.trim(),label=open?'Hide patient data':hasData?'Show patient data':'Add patient data';
    input.hidden=!open;button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',label);button.title=label;button.querySelector('span').textContent=open?'−':'+';button.classList.toggle('has-data',hasData);
  }
  function holdCurrentDraft(){
    if(activeStudy?.id===currentExamId&&!activeStudy.hasContent){const {study}=snapshotStudy();study.revision=activeStudy.revision;currentExamDraft={study,photos:new Map()};}
  }
  function snapshotStudy(){
    const photos=[];
    const savedRuns=runs.map(run=>({number:run.number,createdAt:run.createdAt,createdLabel:run.createdLabel,vessel:run.vessel,phase:run.phase,modality:run.modality,collapsed:run.collapsed,segmentSequence:run.segmentSequence,segments:run.segments.map(({s})=>{
      const {vessel,phase,modality,photo,photoLoading,photoMessage,...fields}=s;
      let savedPhoto=null;
      if(photo){photo.id ||= studyId();savedPhoto={id:photo.id,width:photo.width,height:photo.height};if(!knownPhotos.has(photo.id))photos.push({id:photo.id,width:photo.width,height:photo.height,dataUrl:photo.dataUrl});}
      return {...fields,references:{...s.references},photo:savedPhoto};
    })}));
    return {study:{formatVersion:1,id:activeStudy.id,createdAt:activeStudy.createdAt,updatedAt:activeStudy.updatedAt,hasContent:activeStudy.hasContent,recovered:!!activeStudy.recovered,recoveryWarning:activeStudy.recoveryWarning||'',writerId,editToken:activeStudy.editToken,revision:activeStudy.revision+1,patientData:document.querySelector('#patient-data').value,runSequence,segmentSequence,runs:savedRuns},photos};
  }
  function journalStudy(){
    try{const snapshot=snapshotStudy();sessionStorage.setItem(journalPrefix+activeStudy.id,JSON.stringify({...snapshot,expectedRevision:activeStudy.revision}));}catch{}
  }
  function clearJournal(study){
    try{const key=journalPrefix+study.id,journal=JSON.parse(sessionStorage.getItem(key));if(journal?.study.editToken===study.editToken)sessionStorage.removeItem(key);}catch{}
  }
  async function recoverJournals(excludeId=null){
    const journals=[];let recovered=0;
    try{for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i);if(key.startsWith(journalPrefix)){const journal=JSON.parse(sessionStorage.getItem(key));if(journal?.study?.formatVersion===1&&journal.study.id!==excludeId)journals.push(journal);}}}catch{}
    for(const journal of journals){
      if(!journal.study.hasContent){clearJournal(journal.study);continue;}
      const stored=await store.load(journal.study.id);
      if(stored?.study.editToken===journal.study.editToken){clearJournal(journal.study);continue;}
      // An intentional deletion in another tab must never be resurrected.
      if(!stored&&journal.expectedRevision>0){clearJournal(journal.study);continue;}
      const conflict=stored&&stored.study.revision!==journal.expectedRevision&&stored.study.writerId!==journal.study.writerId;
      if(conflict){
        // Preserve unfinished edits as a separate record rather than overwrite another tab.
        const originalId=journal.study.id,ids=journal.study.runs.flatMap(run=>run.segments.map(s=>s.photo?.id).filter(Boolean)),photos=await store.readPhotos(ids);
        journal.photos.forEach(photo=>photos.set(photo.id,photo));const copied=[];
        for(const run of journal.study.runs)for(const segment of run.segments){if(!segment.photo)continue;const photo=photos.get(segment.photo.id);if(photo){const id=studyId();copied.push({...photo,id});segment.photo={id,width:photo.width,height:photo.height};}else{segment.photo=null;journal.study.recoveryWarning='A photo was unavailable when recovering unfinished edits.';}}
        journal.study.id=studyId();journal.study.revision=1;journal.study.recovered=true;
        await store.save(journal.study,copied,0,false);
        recovered++;
        try{sessionStorage.removeItem(journalPrefix+originalId);}catch{}
      }else{
        const expected=stored?.study.revision??0;journal.study.revision=expected+1;
        await store.save(journal.study,journal.photos,expected,false);clearJournal(journal.study);recovered++;
      }
    }
    return recovered;
  }
  function markStudyChanged(content=true){
    if(hydrating||!activeStudy)return;
    if(content){activeStudy.hasContent=true;activeStudy.updatedAt=new Date().toISOString();}
    if(!activeStudy.hasContent)return;
    dirty=true;changeVersion++;activeStudy.editToken=studyId();journalStudy();saveFeedback('saving','Saving…');
    if(!persistRequested&&content){persistRequested=true;try{navigator.storage?.persist?.().catch(()=>{});}catch{}}
    if(!saveScheduled){saveScheduled=true;queueMicrotask(()=>{saveScheduled=false;void flushStudy();});}
  }
  async function flushStudy(){
    if(hydrating||!activeStudy)return false;
    if(saveTask)return saveTask;
    if(!dirty&&!recoveryPending)return true;
    saveTask=(async()=>{
      try{
        if(recoveryPending){const recovered=await recoverJournals(activeStudy.id);recoveryPending=false;if(recovered)document.querySelector('#notice').textContent='Unfinished edits were recovered in Records.';}
        while(dirty){
          const version=changeVersion,{study,photos}=snapshotStudy(),expected=activeStudy.revision;
          await store.save(study,photos,expected,false);
          activeStudy.revision=study.revision;photos.forEach(photo=>knownPhotos.add(photo.id));clearJournal(study);
          if(activeStudy.id===currentExamId)currentExamDraft=null;
          dirty=version!==changeVersion;if(dirty)journalStudy();saveFailure=null;
        }
        saveFailure=null;saveFeedback('saved','');if(currentView==='records')void refreshRecords();return true;
      }catch(error){
        saveFailure=error;
        const message=error.code==='conflict'?'Another tab changed this study. Reload its saved version before continuing to save.':error.code==='deleted'?'This study was deleted in another tab. Export any changes before reloading.':error.name==='QuotaExceededError'?'Device storage is full. Export a PDF or delete older records, then retry saving.':'Could not save on this device. Keep this tab open, export a PDF, and retry saving.';
        saveFeedback('error',message,error);return false;
      }
    })();
    try{return await saveTask;}finally{saveTask=null;}
  }
  function clearEditor(){runs.forEach(run=>run.segments.forEach(card=>card.dispose()));runs.length=0;document.querySelector('#runs').replaceChildren();runSequence=segmentSequence=0;}
  function showExam(scroll=0){
    if(currentView==='records')recordScroll=window.scrollY;
    currentView='exam';document.querySelector('#exam-page').hidden=false;document.querySelector('#records-page').hidden=true;document.querySelector('.export-actions').hidden=false;
    document.title='Plaque Burden — Exam';closeNavigation();studyBanner();window.scrollTo(0,scroll);
  }
  function restoreStudy(loaded){
    const study=loaded.study;
    if(study.formatVersion!==1||!Array.isArray(study.runs))throw new Error('This saved study could not be opened.');
    for(const run of study.runs)for(const s of run.segments){if(s.photo&&!loaded.photos.has(s.photo.id))throw new Error('A saved photo is missing. This study could not be opened.');}
    hydrating=true;
    try{
      clearEditor();activeStudy={id:study.id,createdAt:study.createdAt,updatedAt:study.updatedAt,hasContent:study.hasContent,revision:study.revision,editToken:study.editToken,recovered:study.recovered,recoveryWarning:study.recoveryWarning};
      document.querySelector('#patient-data').value=study.patientData;showPatientData(!!study.patientData.trim());runSequence=study.runSequence;segmentSequence=study.segmentSequence;
      for(const saved of study.runs){const segments=saved.segments.map(s=>({...s,references:{...s.references},photo:s.photo?{...loaded.photos.get(s.photo.id)}:null,photoLoading:false,photoMessage:''}));createRun({...saved,segments});}
      loaded.photos.forEach(photo=>knownPhotos.add(photo.id));dirty=false;saveFailure=null;changeVersion++;
      syncExportControls();document.querySelector('#empty-runs').hidden=runs.length>0;document.querySelector('#notice').textContent='';studyBanner();saveFeedback('saved','');
    }finally{hydrating=false;}
  }
  function blankExam(){
    hydrating=true;
    try{
      clearEditor();const created=new Date().toISOString();currentExamId=studyId();currentExamDraft=null;activeStudy={id:currentExamId,createdAt:created,updatedAt:created,hasContent:false,revision:0};
      document.querySelector('#patient-data').value='';showPatientData(false);document.querySelector('#notice').textContent='';dirty=false;saveFailure=null;changeVersion++;examScroll=0;createRun();studyBanner();saveFeedback('idle','');
    }finally{hydrating=false;}
  }
  function closeNavigation(){document.querySelector('#app-menu').hidden=true;document.querySelector('#app-menu-toggle').setAttribute('aria-expanded','false');}
  function canLeaveStudy(){
    if(allCards().some(card=>card.s.photoLoading)){saveFeedback('saving','Please wait for the photo to finish preparing before switching studies.');return false;}
    return true;
  }
  async function openStudy(id){
    if(hydrating||navigationBusy)return;
    if(activeStudy?.id===id){showExam(examScroll);return;}
    if(!canLeaveStudy())return;
    navigationBusy=true;
    try{
      if(!await flushStudy())return;
      holdCurrentDraft();
      let loaded=id===currentExamId&&currentExamDraft?currentExamDraft:await store.load(id);
      if(!loaded&&id===currentExamId){blankExam();showExam();return;}
      if(!loaded)throw new Error('This study is no longer in Records.');
      restoreStudy(loaded);showExam();
    }catch(error){document.querySelector('#record-notice').textContent=error.message;}
    finally{navigationBusy=false;}
  }
  async function newExam(){
    if(hydrating||navigationBusy||!canLeaveStudy())return;
    navigationBusy=true;
    try{if(!await flushStudy())return;blankExam();showExam();}
    finally{navigationBusy=false;}
  }
  async function showRecords(){
    if(hydrating||navigationBusy)return;
    navigationBusy=true;
    try{
      closeNavigation();await flushStudy();
      if(currentView==='exam')examScroll=window.scrollY;
      currentView='records';document.querySelector('#exam-page').hidden=true;document.querySelector('#records-page').hidden=false;document.querySelector('.export-actions').hidden=true;studyBanner();
      document.title='Plaque Burden — Records';await refreshRecords();if(currentView==='records'){document.querySelector('#records-heading').focus({preventScroll:true});window.scrollTo(0,recordScroll);}
    }finally{navigationBusy=false;}
  }
  function renderRecords(){
    const query=document.querySelector('#record-search').value.normalize('NFKC').toLocaleLowerCase().trim(),words=query.split(/\s+/).filter(Boolean);
    const entries=recordEntries.filter(entry=>words.every(word=>entry.patientData.normalize('NFKC').toLocaleLowerCase().includes(word))),list=document.querySelector('#record-list');list.replaceChildren();
    for(const entry of entries){
      const row=document.createElement('article');row.className='study-record';row.dataset.studyId=entry.id;
      const open=document.createElement('button');open.type='button';open.className='record-open';open.dataset.openStudy=entry.id;
      const heading=document.createElement('strong');heading.className='record-title';heading.textContent=entry.patientData.trim().split(/\r?\n/)[0]||'Untitled study';open.append(heading);
      if(entry.recovered){const badge=document.createElement('span');badge.className='current-study-badge';badge.textContent='Recovered edits';open.append(badge);}
      const details=entry.patientData.trim().split(/\r?\n/).slice(1).join(' · ');if(details){const p=document.createElement('p');p.className='record-patient-details';p.textContent=details;open.append(p);}
      const time=document.createElement('time');time.dateTime=entry.createdAt;time.textContent=studyDate(entry.createdAt);open.append(time);
      const summary=document.createElement('small');summary.textContent=entry.devices.join(' / ')+' · '+entry.vessels.join(', ')+' · '+entry.runCount+' run'+(entry.runCount===1?'':'s')+' · '+entry.segmentCount+' segment'+(entry.segmentCount===1?'':'s')+(entry.photoCount?' · '+entry.photoCount+' photo'+(entry.photoCount===1?'':'s'):'');open.append(summary);
      const remove=document.createElement('button');remove.type='button';remove.className='record-delete delete-button';remove.dataset.deleteStudy=entry.id;remove.textContent='Delete';remove.setAttribute('aria-label','Delete study '+(entry.patientData.trim().split(/\r?\n/)[0]||studyDate(entry.createdAt)));
      if(entry.recoveryWarning){const warning=document.createElement('small');warning.textContent=entry.recoveryWarning;open.append(warning);}row.append(open,remove);list.append(row);
    }
    document.querySelector('#record-count').textContent=entries.length+' '+(query?'matching ':'')+'stud'+(entries.length===1?'y':'ies');
    const empty=document.querySelector('#records-empty');empty.hidden=entries.length>0;empty.textContent=query?'No studies match your search.':'No saved studies yet. Start an exam and it will be recorded automatically.';
  }
  async function refreshRecords(){
    const version=++recordsVersion,page=document.querySelector('#records-page');page.setAttribute('aria-busy','true');
    try{const entries=await store.list();if(version!==recordsVersion)return;recordEntries=entries.filter(entry=>entry.hasContent).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.updatedAt.localeCompare(a.updatedAt));document.querySelector('#record-notice').textContent='';renderRecords();}
    catch{document.querySelector('#record-notice').textContent='Records could not be read from this device. Return to your exam and retry saving.';}
    finally{if(version===recordsVersion)page.setAttribute('aria-busy','false');}
  }
  async function deleteStudy(id){
    if(navigationBusy||!canLeaveStudy())return;
    const entry=recordEntries.find(s=>s.id===id);if(!entry)return;
    if(!window.confirm('Delete this saved study and its photos from this device?\n\n'+(entry.patientData.trim().split(/\r?\n/)[0]||studyDate(entry.createdAt))))return;
    navigationBusy=true;
    try{
      const saved=await flushStudy();
      if(!saved&&id===currentExamId&&activeStudy?.id!==id){document.querySelector('#record-notice').textContent='Save or export the open study before deleting the current exam.';return;}
      await store.remove(id);try{sessionStorage.removeItem(journalPrefix+id);}catch{}
      if(id===currentExamId)blankExam();
      else if(id===activeStudy?.id){const current=currentExamDraft||await store.load(currentExamId);if(current)restoreStudy(current);else blankExam();}
      if(dirty)await flushStudy();await refreshRecords();
    }catch(error){document.querySelector('#record-notice').textContent='Could not delete this study. '+error.message;}
    finally{navigationBusy=false;}
  }
  async function reloadSavedStudy(){
    if(navigationBusy||!window.confirm('Reload the saved study? Unsaved changes in this tab will be replaced.'))return;
    navigationBusy=true;
    try{try{sessionStorage.removeItem(journalPrefix+activeStudy.id);}catch{}let loaded=await store.load(activeStudy.id);if(!loaded&&activeStudy.id!==currentExamId)loaded=currentExamDraft||await store.load(currentExamId);if(loaded)restoreStudy(loaded);else blankExam();showExam();}
    catch(error){saveFeedback('error',error.message);}
    finally{navigationBusy=false;}
  }
  async function initializeStudies(){
    syncExportControls();document.querySelector('#app-menu-toggle').disabled=true;
    let recovered=0,recoveryError=null;
    try{
      await store.database();recovered=await recoverJournals();
    }catch(error){recoveryPending=true;recoveryError=error;}
    blankExam();
    if(recoveryError){saveFailure=recoveryError;saveFeedback('error','Device storage is unavailable or previous edits could not be recovered. Keep this tab open and retry saving.',recoveryError);}
    else if(recovered)document.querySelector('#notice').textContent='Unfinished edits were recovered in Records.';
    try{sessionStorage.removeItem('plaque-burden-current-exam');}catch{}
    hydrating=false;document.querySelector('#exam-page').inert=false;document.querySelector('#exam-page').setAttribute('aria-busy','false');document.querySelector('#app-menu-toggle').disabled=false;studyBanner();
  }
  function syncExportControls(){
    const cards=allCards(),selected=cards.filter(card=>card.s.selected);
    document.querySelector('#export').disabled=!cards.length||cards.some(card=>card.s.photoLoading);
    document.querySelector('#export').textContent='↓ Export all ('+cards.length+')';
    const button=document.querySelector('#export-selected');
    button.disabled=!selected.length||selected.some(card=>card.s.photoLoading);
    button.textContent='↓ Export selected ('+selected.length+')';
    document.querySelector('#selection-count').textContent=selected.length+' of '+cards.length+' segments selected';
    document.querySelector('#select-all').disabled=!cards.length||selected.length===cards.length;
    document.querySelector('#clear-selection').disabled=!selected.length;
  }
  const vessels=['LM','LAD','LCX','RCA','Ramus'];
  const stages = [['pre','Pre-balloon'],['post','Post-balloon'],['initial','Post stent - initial'],['final','Post stent - final']];
  const targets = [['nonTarget','Non target'],['proximalLanding','Proximal landing zone'],['distalLanding','Distal landing zone'],['minimalLumen','Minimal lumen area'],['minimalStent','Minimal stent area']];
  const targetName = s => targets.find(([key])=>key===s.targetAnnotation)[1];
  const stageName = s => stages.find(([key])=>key===s.phase)[1];
  const referenceTypes=[['intima','Intima'],['iem','IEM'],['eem','EEM'],['manual','Manual']];
  const referenceShort=s=>referenceTypes.find(([key])=>key===s.referenceType)[1];
  const hasStent=s=>s.stentEnabled;
  const canSelectProlapse=s=>hasStent(s)&&['initial','final'].includes(s.phase);
  const lumenLinked=s=>canSelectProlapse(s)&&s.plaqueProlapse==='none';
  // Keep the entered lumen measurement so leaving the linked mode restores it.
  const lumenArea=s=>lumenLinked(s)?s.stent:s.lumen;
  const measurementDisabled=(s,key)=>(key==='stent'&&!hasStent(s))||(key==='lumen'&&lumenLinked(s));
  const tissueLabel=s=>canSelectProlapse(s)?'Plaque prolapse':'In-stent tissue burden';
  const area=d=>Math.PI*d*d/4,diameter=a=>Math.sqrt(4*a/Math.PI),fmt=a=>a.toFixed(2);
  const reference=s=>s.references[s.referenceType];
  const expansion=s=>100*s.stent/reference(s);
  const burden=s=>100*(1-lumenArea(s)/reference(s));
  const outsideBurden=s=>100*(1-s.stent/reference(s));
  const tissueBurden=s=>100*(1-lumenArea(s)/s.stent);
  const targetArea=s=>reference(s)*s.target/100;
  const burdenLabel=s=>s.referenceType==='eem'?'Plaque burden':s.referenceType==='intima'?'Lumen area stenosis':s.referenceType==='iem'?'IEM area burden':'Reference area burden';
  const mainLabel=s=>hasStent(s)?'Stent expansion':burdenLabel(s);
  const ready=s=>reference(s)!==null&&reference(s)>0;
  function valid(s){return hasStent(s)?lumenArea(s)<=s.stent:!ready(s)||lumenArea(s)<=reference(s);}
  const measurementValue=(s,key)=>key==='referenceArea'?reference(s):key==='lumen'?lumenArea(s):s[key];
  const choice = (key,label,options) => `<label>${label}<select data-key="${key}">${options.map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label>`;
  const wheel = (key,label,unit='mm²',isDiameter=false,visibleLabel=label) => `<div class="wheel-group"><label>${visibleLabel}</label><div class="number-picker"><div class="picker-columns">${['whole','decimal'].map(place=>`<div class="wheel-column"><span class="wheel-caption">${place==='whole'?'Whole':'Decimal'}</span><div class="digit-wheel" data-key="${key}" data-diameter="${isDiameter}" data-place="${place}" role="spinbutton" tabindex="0" aria-label="${label} ${place}" aria-valuemin="0"><div class="wheel-track"></div></div></div>`).join('')}</div><div class="picker-value"><input aria-label="${label}" data-key="${key}" data-diameter="${isDiameter}" type="number" min="0.01" step="0.1" inputmode="decimal"><span class="unit">${unit}</span></div></div></div>`;
  function plannerMarkup(){return `<section class="desired-expansion"><h4>Desired stent expansion</h4><div class="desired-options">${[70,75,80,85,90,95,100].map(n=>`<button type="button" data-target="${n}">${n}%</button>`).join('')}</div><div class="target-values"><span>Target stent area<strong class="target-area"></strong></span><span>Target equivalent diameter<strong class="target-diameter"></strong></span></div></section>`;}
  function gridMarkup(s){return `<section class="unified-measurements panel" aria-labelledby="segment-${s.id}-measurement-heading"><div class="measurement-heading"><h3 id="segment-${s.id}-measurement-heading">Measurements</h3><button type="button" class="measurement-collapse" aria-expanded="true" aria-controls="segment-${s.id}-measurements"><span class="measurement-collapse-icon" aria-hidden="true">▼</span></button></div><div class="measurement-content" id="segment-${s.id}-measurements"><div class="frame-grid"><div class="frame-head"><span class="frame-title">Lumen</span><div class="plaque-prolapse-control"><select class="pp-selector" data-key="plaqueProlapse" aria-label="Plaque prolapse"><option value="none">No plaque prolapse (no PP)</option><option value="present">Plaque prolapse (PP)</option></select><span class="pp-compact-label" aria-hidden="true"></span></div></div><div class="frame-head"><span class="frame-title">Stent</span><button class="stent-toggle" type="button" aria-pressed="false"><span class="toggle-indicator" aria-hidden="true"><span></span></span><span class="stent-toggle-label">Off</span></button></div><div class="frame-head"><span class="frame-title">Reference</span><select class="reference-selector" data-key="referenceType" aria-label="Reference contour">${referenceTypes.map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></div>${['lumen','stent','referenceArea'].map((key,i)=>`<div class="frame-cell ${key==='stent'?'stent-cell':''}" data-column="${i}">${wheel(key,(i===0?'Lumen':i===1?'Stent':'Reference')+' area','mm²',false,'Area')}</div>`).join('')}${['lumen','stent','referenceArea'].map((key,i)=>`<div class="frame-cell ${key==='stent'?'stent-cell':''}" data-column="${i}">${wheel(key,(i===0?'Lumen':i===1?'Stent':'Reference')+' equivalent diameter','mm',true,'Diameter')}</div>`).join('')}</div><p class="reference-description"></p></div></section>`;}
  function diagramSpec(s){
    if(!valid(s))return [];
    const st=hasStent(s),ref=ready(s)?reference(s):0,max=Math.max(ref,lumenArea(s),st?s.stent:0,st&&ready(s)&&s.planning?targetArea(s):0),radius=a=>92*Math.sqrt(a/max),rings=[];
    if(ref>0)rings.push({r:radius(ref),type:s.referenceType==='eem'?(st?'eem':'plaque'):'reference',label:referenceShort(s)+' reference'});
    if(st)rings.push({r:radius(s.stent),type:'tissue',label:canSelectProlapse(s)&&lumenArea(s)<s.stent?'Plaque prolapse':null});
    rings.push({r:radius(lumenArea(s)),type:'lumen',label:'Lumen'});
    if(st&&ready(s)&&s.planning)rings.push({r:radius(targetArea(s)),type:'target',label:'Desired stent'});
    if(st)rings.push({r:radius(s.stent),type:'stent',label:'Measured stent'});
    return rings;
  }
  function photoMarkup(){
    return `<section class="frame-photo" aria-label="Frame photo" hidden><button type="button" class="photo-view" hidden><img class="photo-preview" alt=""><span aria-hidden="true">↗</span></button><input class="photo-file" data-source="camera" type="file" accept="image/*" capture="environment" aria-label="Take frame photo" hidden><input class="photo-file" data-source="library" type="file" accept="image/*" aria-label="Choose frame photo" hidden></section>`;
  }
  function photoButtonMarkup(){
    return `<button type="button" class="photo-trigger photo-edit frame-action" aria-label="Add frame photo" title="Add frame photo" aria-haspopup="dialog" aria-controls="photo-source"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 16 5-5 4 4 3-3 6 6"/></svg></button>`;
  }
  function noteButtonMarkup(s){
    return `<button type="button" class="note-trigger frame-action" aria-label="Add frame note" title="Add frame note" aria-expanded="false" aria-controls="segment-${s.id}-notes"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg></button>`;
  }
  const sourceDialog=document.querySelector('#photo-source'),viewerDialog=document.querySelector('#photo-viewer');
  const viewport=viewerDialog.querySelector('.photo-viewport'),viewerImage=viewport.querySelector('img');
  let sourceCard=null,viewerCard=null,gesture=null,lastTap=null;
  const pointers=new Map(),zoom={scale:1,x:0,y:0};
  const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));
  const syncModalLock=()=>document.body.classList.toggle('photo-modal-open',sourceDialog.open||viewerDialog.open);
  function photoContext(card){return `Run ${card.run.number} / Segment ${card.s.number} · ${card.s.vessel} · ${card.s.segment} · ${card.s.modality} · ${stageName(card.s)}`;}
  function openPhotoSource(card){
    if(card.s.photoLoading)return;
    if(viewerDialog.open)viewerDialog.close();
    sourceCard=card;sourceDialog.querySelector('h2').textContent=card.s.photo?'Change frame photo':'Add frame photo';
    sourceDialog.querySelector('.photo-source-context').textContent=photoContext(card);
    sourceDialog.querySelector('[data-photo-source="remove"]').hidden=!card.s.photo;
    sourceDialog.showModal();syncModalLock();
  }
  function closePhotoDialogs(card){
    if(sourceCard===card){sourceDialog.close();sourceCard=null;}
    if(viewerCard===card){viewerDialog.close();viewerCard=null;}
    syncModalLock();
  }
  function paintZoom(){
    if(!viewerCard?.s.photo)return;
    const rect=viewport.getBoundingClientRect(),photo=viewerCard.s.photo,fit=Math.min(rect.width/photo.width,rect.height/photo.height);
    const maxX=Math.max(0,(photo.width*fit*zoom.scale-rect.width)/2),maxY=Math.max(0,(photo.height*fit*zoom.scale-rect.height)/2);
    zoom.x=clamp(zoom.x,-maxX,maxX);zoom.y=clamp(zoom.y,-maxY,maxY);
    viewerImage.style.transform=`translate(${zoom.x}px,${zoom.y}px) scale(${zoom.scale})`;
    viewport.classList.toggle('is-zoomed',zoom.scale>1);
    viewerDialog.querySelector('.photo-zoom-percent').textContent=Math.round(zoom.scale*100)+'%';
    viewerDialog.querySelector('[data-zoom="out"]').disabled=zoom.scale<=1;
    viewerDialog.querySelector('[data-zoom="in"]').disabled=zoom.scale>=5;
  }
  function zoomAt(value,clientX,clientY){
    const rect=viewport.getBoundingClientRect(),x=(clientX??rect.left+rect.width/2)-(rect.left+rect.width/2),y=(clientY??rect.top+rect.height/2)-(rect.top+rect.height/2),scale=clamp(value,1,5),factor=scale/zoom.scale;
    zoom.x=x-(x-zoom.x)*factor;zoom.y=y-(y-zoom.y)*factor;zoom.scale=scale;paintZoom();
  }
  function openPhotoViewer(card){
    if(!card.s.photo||card.s.photoLoading)return;
    if(sourceDialog.open)sourceDialog.close();
    viewerCard=card;zoom.scale=1;zoom.x=zoom.y=0;pointers.clear();gesture=null;lastTap=null;
    viewerDialog.querySelector('h2').textContent=card.s.modality+' frame photo';
    viewerDialog.querySelector('.photo-viewer-context').textContent=photoContext(card);
    viewerImage.src=card.s.photo.dataUrl;viewerImage.alt=card.s.modality+' frame, run '+card.run.number+', segment '+card.s.number;
    viewerDialog.showModal();syncModalLock();paintZoom();
  }
  sourceDialog.addEventListener('click',event=>{
    const action=event.target.closest('[data-photo-source]')?.dataset.photoSource,card=sourceCard;
    if(!action||!card)return;
    sourceDialog.close();
    if(action==='remove')card.clearPhoto();
    else if(action==='camera'||action==='library')card.el.querySelector(`.photo-file[data-source="${action}"]`).click();
  });
  sourceDialog.addEventListener('close',()=>{if(!sourceDialog.open)sourceCard=null;syncModalLock();});
  sourceDialog.addEventListener('click',event=>{if(event.target!==sourceDialog)return;const rect=sourceDialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)sourceDialog.close();});
  viewerDialog.querySelector('.photo-viewer-close').addEventListener('click',()=>viewerDialog.close());
  viewerDialog.addEventListener('close',()=>{if(!viewerDialog.open){viewerCard=null;pointers.clear();gesture=null;viewerImage.removeAttribute('src');}syncModalLock();});
  viewerDialog.querySelectorAll('[data-zoom]').forEach(button=>button.addEventListener('click',()=>zoomAt(button.dataset.zoom==='reset'?1:zoom.scale+(button.dataset.zoom==='in'?.5:-.5))));
  function startGesture(){
    const points=[...pointers.values()];
    if(points.length>=2){points.forEach(p=>p.moved=true);const a=points[0],b=points[1];gesture={kind:'pinch',distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),scale:zoom.scale,x:zoom.x,y:zoom.y,midX:(a.x+b.x)/2,midY:(a.y+b.y)/2};}
    else if(points.length===1)gesture={kind:'pan',x:points[0].x,y:points[0].y,originX:zoom.x,originY:zoom.y};
    else gesture=null;
  }
  viewport.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    event.preventDefault();viewport.focus({preventScroll:true});viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false});startGesture();
  });
  viewport.addEventListener('pointermove',event=>{
    const point=pointers.get(event.pointerId);if(!point||!gesture)return;
    point.x=event.clientX;point.y=event.clientY;point.moved ||= Math.hypot(point.x-point.startX,point.y-point.startY)>6;
    if(gesture.kind==='pinch'&&pointers.size>=2){
      const [a,b]=[...pointers.values()],rect=viewport.getBoundingClientRect(),scale=clamp(gesture.scale*Math.hypot(a.x-b.x,a.y-b.y)/gesture.distance,1,5),factor=scale/gesture.scale;
      zoom.scale=scale;zoom.x=(a.x+b.x)/2-(rect.left+rect.width/2)-(gesture.midX-(rect.left+rect.width/2)-gesture.x)*factor;
      zoom.y=(a.y+b.y)/2-(rect.top+rect.height/2)-(gesture.midY-(rect.top+rect.height/2)-gesture.y)*factor;
    }else if(zoom.scale>1){zoom.x=gesture.originX+point.x-gesture.x;zoom.y=gesture.originY+point.y-gesture.y;}
    paintZoom();
  });
  function finishPointer(event){
    const point=pointers.get(event.pointerId);if(!point)return;pointers.delete(event.pointerId);
    if(event.type==='pointerup'&&!point.moved&&event.pointerType!=='mouse'){
      const now=performance.now();if(lastTap&&now-lastTap.time<350&&Math.hypot(point.x-lastTap.x,point.y-lastTap.y)<30){zoomAt(zoom.scale>1?1:2,point.x,point.y);lastTap=null;}else lastTap={time:now,x:point.x,y:point.y};
    }
    startGesture();
  }
  viewport.addEventListener('pointerup',finishPointer);viewport.addEventListener('pointercancel',finishPointer);viewport.addEventListener('lostpointercapture',finishPointer);
  viewport.addEventListener('dblclick',event=>{event.preventDefault();zoomAt(zoom.scale>1?1:2,event.clientX,event.clientY);});
  viewport.addEventListener('wheel',event=>{event.preventDefault();zoomAt(zoom.scale*(event.deltaY<0?1.15:1/1.15),event.clientX,event.clientY);},{passive:false});
  viewport.addEventListener('keydown',event=>{
    if(['+','=','-','0'].includes(event.key)){event.preventDefault();zoomAt(event.key==='0'?1:zoom.scale+(event.key==='-'?-.5:.5));}
    else if(zoom.scale>1&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();zoom.x+=event.key==='ArrowLeft'?40:event.key==='ArrowRight'?-40:0;zoom.y+=event.key==='ArrowUp'?40:event.key==='ArrowDown'?-40:0;paintZoom();}
  });
  window.addEventListener('resize',()=>{if(viewerDialog.open)paintZoom();});
  function createSegment(run,saved=null){
    const s={id:saved?saved.id:++segmentSequence,number:saved?saved.number:++run.segmentSequence,segment:'ostial',targetAnnotation:'nonTarget',lumen:5,stent:6,stentEnabled:false,plaqueProlapse:'none',referenceType:'eem',references:{intima:null,iem:null,eem:run.modality==='OCT'?null:12,manual:null},findings:'',notesOpen:!!saved?.findings?.trim(),measurementsCollapsed:false,selected:false,photo:null,photoLoading:false,photoMessage:'',target:90,planning:true,collapsed:false,...saved};
    segmentSequence=Math.max(segmentSequence,s.id);run.segmentSequence=Math.max(run.segmentSequence,s.number);
    Object.defineProperties(s,{vessel:{enumerable:true,get:()=>run.vessel},phase:{enumerable:true,get:()=>run.phase},modality:{enumerable:true,get:()=>run.modality}});
    const el=document.createElement('section');el.className='segment-card';
    let disposed=false,photoVersion=0;
    const card={s,el,run,render,clearPhoto,dispose:()=>{disposed=true;photoVersion++;closePhotoDialogs(card);s.photo=null;}};
    run.segments.push(card);run.el.querySelector('.run-segments').append(el);
    let rendering=false;
    function render(active=null){
      if(rendering||disposed)return;rendering=true;
      try{
      const st=hasStent(s),key=[s.phase,s.modality].join(':');
      if(el.dataset.layout!==key){
        el.dataset.layout=key;
        el.innerHTML=`<div class="segment-heading"><label class="segment-select"><input type="checkbox" class="segment-export-select" aria-label="Select segment ${s.number} from device run ${run.number} for export"><span class="sr-only">Select for export</span></label><h3>Segment ${s.number}</h3><button type="button" class="segment-delete delete-button" aria-label="Delete segment ${s.number}">Delete</button><button type="button" class="collapse-toggle"><span class="collapsed-summary"></span><span class="collapse-icon" aria-hidden="true">▼</span></button></div><div class="segment-content" id="segment-${s.id}-content"><div class="annotations">${choice('segment','Location',['ostial','proximal','mid','distal'].map(v=>[v,v[0].toUpperCase()+v.slice(1)]))}${choice('targetAnnotation','Target',targets)}</div><div class="result panel frame-result"><div class="result-top"><span class="panel-index analysis-heading"></span><div class="result-tools">${noteButtonMarkup(s)}${photoButtonMarkup()}</div></div><p class="photo-status" role="status"></p><div class="frame-visuals"><div class="vessel-visual" role="img"><svg viewBox="0 0 240 240" aria-hidden="true"></svg><div class="visual-label"></div></div>${photoMarkup()}</div><div class="analysis-values"><p class="validation-note" role="status"></p><div class="result-value"><output aria-live="polite"></output><span class="result-basis"></span></div><div class="isr-results"><div><span class="tissue-label"></span><strong class="tissue-result"></strong></div><div class="outside-metric"><span>Outside-stent plaque burden</span><strong class="outside-result"></strong></div><div class="total-metric"><span>Total plaque burden</span><strong class="total-result"></strong></div></div></div><div class="diagram-legend"></div>${plannerMarkup()}</div><label class="frame-notes" id="segment-${s.id}-notes" hidden>Frame findings<textarea class="frame-findings" rows="3" placeholder="Record findings in this frame"></textarea></label>${gridMarkup(s)}</div>`;
      }
      el.querySelectorAll('select').forEach(x=>{x.value=s[x.dataset.key];x.disabled=x.dataset.key==='plaqueProlapse'&&!canSelectProlapse(s);});
      const ppControl=el.querySelector('.plaque-prolapse-control');ppControl.classList.toggle('is-disabled',!canSelectProlapse(s));el.querySelector('.pp-compact-label').textContent=s.plaqueProlapse==='none'?'No PP':'PP';
      el.querySelectorAll('.picker-value input').forEach(x=>{const value=measurementValue(s,x.dataset.key);if(x!==active)x.value=value===null?'':fmt(x.dataset.diameter==='true'?diameter(value):value);x.disabled=measurementDisabled(s,x.dataset.key);});
      el.querySelectorAll('.stent-cell').forEach(x=>x.classList.toggle('stent-disabled',!st));
      el.querySelectorAll('.frame-cell[data-column="0"]').forEach(x=>x.classList.toggle('lumen-disabled',lumenLinked(s)));
      const stentToggle=el.querySelector('.stent-toggle');stentToggle.disabled=false;stentToggle.setAttribute('aria-pressed',String(st));el.querySelector('.stent-toggle-label').textContent=st?'On':'Off';
      el.querySelector('.reference-description').textContent=ready(s)?'':'Enter a traced area or diameter.';
      renderWheels();
      const ok=valid(s),main=st?expansion(s):burden(s);
      el.querySelector('output').textContent=!ok?'—':!ready(s)?'N/A':main.toFixed(1)+'%';
      el.querySelector('.analysis-heading').textContent=mainLabel(s).toUpperCase();el.querySelector('.visual-label').innerHTML=st?'STENT<br>EXPANSION'+(canSelectProlapse(s)?`<span class="visual-pp">PP ${ok?tissueBurden(s).toFixed(1)+'%':'—'}</span>`:''):s.referenceType==='eem'?'PLAQUE<br>BURDEN':'AREA<br>COMPARISON';
      el.querySelector('.result-basis').textContent='Reference: '+referenceShort(s);
      el.querySelector('.validation-note').textContent=ok?'':st?'Check areas: lumen must not exceed the stent contour.':'Check areas: lumen must not exceed the reference contour.';
      el.querySelector('.isr-results').hidden=!st;el.querySelector('.tissue-label').textContent=tissueLabel(s);el.querySelector('.tissue-result').textContent=ok?tissueBurden(s).toFixed(1)+'%':'—';
      const showEEM=st&&s.referenceType==='eem';el.querySelector('.outside-metric').hidden=!showEEM;el.querySelector('.total-metric').hidden=!showEEM;
      el.querySelector('.outside-result').textContent=ok&&ready(s)&&s.stent<=reference(s)?outsideBurden(s).toFixed(1)+'%':'N/A';el.querySelector('.total-result').textContent=ok&&ready(s)?burden(s).toFixed(1)+'%':'N/A';
      const rings=diagramSpec(s);
      const svg=el.querySelector('.vessel-visual svg'),signature=rings.map(r=>r.type).join(':');
      if(svg.dataset.rings!==signature){svg.dataset.rings=signature;svg.innerHTML='<circle class="outer-halo" cx="120" cy="120" r="111"/>'+rings.map(r=>`<circle class="diagram-${r.type}" cx="120" cy="120" r="${r.r}"/>`).join('');}else rings.forEach((r,i)=>svg.children[i+1].setAttribute('r',r.r));
      el.querySelector('.diagram-legend').innerHTML=rings.filter(r=>r.label).map(r=>`<span class="legend-${r.type}">${r.label}</span>`).join('')+(st?'<small>Coincident outlines indicate equal areas.</small>':'');
      el.querySelector('.vessel-visual').setAttribute('aria-label',ok?`${st?'Stent expansion':'Vessel contours'}; ${rings.filter(r=>r.label).map(r=>r.label).join(', ')}${canSelectProlapse(s)?'; plaque prolapse '+tissueBurden(s).toFixed(1)+'%':''}`:'Diagram unavailable: inconsistent areas');
      const canPlan=st&&ready(s);
      const desired=el.querySelector('.desired-expansion');desired.classList.toggle('is-disabled',!canPlan);desired.setAttribute('aria-disabled',String(!canPlan));
      el.querySelectorAll('[data-target]').forEach(b=>{b.disabled=!canPlan;b.setAttribute('aria-pressed',String(canPlan&&Number(b.dataset.target)===s.target));});
      el.querySelector('.target-area').textContent=canPlan?fmt(targetArea(s))+' mm²':'—';el.querySelector('.target-diameter').textContent=canPlan?fmt(diameter(targetArea(s)))+' mm':'—';
      const findings=el.querySelector('.frame-findings');if(findings!==document.activeElement)findings.value=s.findings;
      renderNotes();
      const measurements=el.querySelector('.measurement-content'),measurementToggle=el.querySelector('.measurement-collapse');
      measurements.hidden=s.measurementsCollapsed;measurementToggle.setAttribute('aria-expanded',String(!s.measurementsCollapsed));measurementToggle.setAttribute('aria-label',(s.measurementsCollapsed?'Expand':'Collapse')+' measurements for run '+run.number+', segment '+s.number);el.querySelector('.measurement-collapse-icon').textContent=s.measurementsCollapsed?'▶':'▼';
      el.querySelector('.segment-export-select').checked=s.selected;
      renderPhoto();
      el.classList.toggle('is-collapsed',s.collapsed);
      const content=el.querySelector('.segment-content'),toggle=el.querySelector('.collapse-toggle'),number=s.number;
      content.hidden=s.collapsed;toggle.setAttribute('aria-expanded',String(!s.collapsed));toggle.setAttribute('aria-controls',content.id);toggle.setAttribute('aria-label',(s.collapsed?'Expand':'Collapse')+' segment '+number);
      el.querySelector('.collapsed-summary').textContent=['Segment '+s.number,s.segment[0].toUpperCase()+s.segment.slice(1),targetName(s),...(s.photo?['Photo']:[])].join(' · ');
      el.querySelector('.collapse-icon').textContent=s.collapsed?'▶':'▼';
      }finally{rendering=false;}
    }
    function renderNotes(){
      const trigger=el.querySelector('.note-trigger'),hasNote=!!s.findings.trim(),label=s.notesOpen?'Hide frame note':hasNote?'Show frame note':'Add frame note';
      el.querySelector('.frame-notes').hidden=!s.notesOpen;trigger.setAttribute('aria-expanded',String(s.notesOpen));trigger.setAttribute('aria-label',label);trigger.title=label;trigger.classList.toggle('has-note',hasNote);
    }
    function renderPhoto(){
      el.querySelector('.frame-result').classList.toggle('has-photo',!!s.photo);
      el.querySelector('.frame-photo').hidden=!s.photo;
      const trigger=el.querySelector('.photo-trigger'),label=(s.photo?'Change or remove ':'Add ')+s.modality+' frame photo';
      trigger.setAttribute('aria-label',label);trigger.title=label;trigger.setAttribute('aria-busy',String(s.photoLoading));trigger.classList.toggle('has-photo',!!s.photo);
      const view=el.querySelector('.photo-view'),preview=el.querySelector('.photo-preview');
      view.hidden=!s.photo;view.disabled=s.photoLoading;
      view.setAttribute('aria-label','View '+s.modality+' photo for run '+run.number+', segment '+s.number);
      if(s.photo){if(preview.getAttribute('src')!==s.photo.dataUrl)preview.src=s.photo.dataUrl;preview.alt=s.modality+' frame, run '+run.number+', segment '+s.number;}
      else preview.removeAttribute('src');
      el.querySelectorAll('.photo-edit').forEach(button=>button.disabled=s.photoLoading);
      const status=el.querySelector('.photo-status');status.textContent=s.photoLoading?'Preparing photo…':s.photoMessage;status.classList.toggle('is-error',!!s.photoMessage);
    }
    function clearPhoto(){photoVersion++;s.photo=null;s.photoLoading=false;s.photoMessage='';render();syncExportControls();markStudyChanged();}
    async function addPhoto(file){
      const version=++photoVersion;let url,changed=false;
      s.photoLoading=true;s.photoMessage='';render();syncExportControls();if(!saveFailure)saveFeedback('saving','Preparing photo for saving…');
      try{
        if(file.size>50*1024*1024)throw new Error('Choose a photo smaller than 50 MB.');
        if(file.type==='image/svg+xml'||(!file.type.startsWith('image/')&&!/\.(jpe?g|png|heic|heif|webp|avif)$/i.test(file.name)))throw new Error('Choose a photo, such as JPEG, PNG or an iPhone camera image.');
        url=URL.createObjectURL(file);
        const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('This photo could not be opened. Try JPEG or PNG, or take a new photo.'));img.src=url;});
        if(disposed||version!==photoVersion)return;
        const ratio=Math.min(1,2400/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
        const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
        const dataUrl=canvas.toDataURL('image/jpeg',.92);
        if(!dataUrl.startsWith('data:image/jpeg'))throw new Error('This photo could not be prepared. Try another photo.');
        s.photo={dataUrl,width:canvas.width,height:canvas.height};changed=true;
      }catch(error){if(!disposed&&version===photoVersion)s.photoMessage=error.message||'This photo could not be opened. Try another photo.';}
      finally{if(url)URL.revokeObjectURL(url);if(!disposed&&version===photoVersion){s.photoLoading=false;render();syncExportControls();if(changed)markStudyChanged();else if(!dirty&&!saveFailure)saveFeedback('saved','');}}
    }
    function trimPrecision(x){if(x.value!==''&&Number.isFinite(Number(x.value))&&((x.value.split('.')[1]||'').length>2||/[eE]/.test(x.value)))x.value=fmt(Number(x.value));}
    function update(x){if(measurementDisabled(s,x.dataset.key))return;trimPrecision(x);const raw=x.value;if(raw===''||!Number.isFinite(Number(raw))||Number(raw)<=0){x.setAttribute('aria-invalid','true');return;}x.removeAttribute('aria-invalid');const value=Number(raw),requested=x.dataset.diameter==='true'?area(value):value,next=Math.max(.01,requested);if(!Number.isFinite(next))return;if(x.dataset.key==='referenceArea')s.references[s.referenceType]=next;else s[x.dataset.key]=next;render(next===requested?x:null);markStudyChanged();}
    function setTarget(value){if(!hasStent(s)||!ready(s)||![70,75,80,85,90,95,100].includes(Number(value)))return false;s.target=Number(Number(value).toFixed(2));render();markStudyChanged();return true;}
    function renderWheels(){
      el.querySelectorAll('.digit-wheel').forEach(w=>{
        const input=el.querySelector(`.picker-value input[data-key="${w.dataset.key}"][data-diameter="${w.dataset.diameter}"]`),raw=Number(input.value),value=Number.isFinite(raw)&&raw>0?raw:Number(fmt(w.dataset.diameter==='true'?diameter(measurementValue(s,w.dataset.key)??0):measurementValue(s,w.dataset.key)??0));
        const disabled=measurementDisabled(s,w.dataset.key);w.tabIndex=disabled?-1:0;w.setAttribute('aria-disabled',String(disabled));w.setAttribute('aria-valuenow',w.dataset.place==='whole'?Math.floor(value):Number((value%1).toFixed(2)));w.setAttribute('aria-valuetext',fmt(value)+' '+input.parentElement.querySelector('.unit').textContent);
        w.querySelector('.wheel-track').innerHTML=[-2,-1,0,1,2].map(offset=>{const next=w.dataset.place==='whole'?Math.floor(value)+offset:Number((value+offset*.1).toFixed(2));const digit=next<0?'':w.dataset.place==='whole'?next:'.'+Math.round((next%1)*100).toString().padStart(2,'0');return `<span class="wheel-option ${offset===0?'selected':''}" data-offset="${offset}">${digit}</span>`;}).join('');
      });
    }
    function adjustWheel(w,steps,base=null){
      if(measurementDisabled(s,w.dataset.key))return;
      const input=el.querySelector(`.picker-value input[data-key="${w.dataset.key}"][data-diameter="${w.dataset.diameter}"]`),current=base??Number(input.value),fraction=Number((current-Math.floor(current)).toFixed(2));
      const next=w.dataset.place==='whole'?Math.max(0,Math.floor(current)+steps)+fraction:current+steps*.1;
      input.value=fmt(Math.max(.01,next));update(input);
    }
    el.addEventListener('input',e=>{const x=e.target;if(x.matches('.frame-findings')){s.findings=x.value;renderNotes();markStudyChanged();}else if(x.matches('.picker-value input'))update(x);});
    el.addEventListener('focusout',e=>{const input=e.target;if(input.matches('.picker-value input')){input.removeAttribute('aria-invalid');const value=measurementValue(s,input.dataset.key);input.value=value===null?'':fmt(input.dataset.diameter==='true'?diameter(value):value);}});
    el.addEventListener('change',e=>{const x=e.target;if(x.matches('.segment-export-select')){s.selected=x.checked;syncExportControls();markStudyChanged(false);return;}if(x.matches('.photo-file')){const file=x.files[0];x.value='';if(file)addPhoto(file);return;}if(!x.matches('select')||x.disabled)return;s[x.dataset.key]=x.value;render();markStudyChanged();});
    let suppressWheelClick=false,drag=null;
    el.addEventListener('click',e=>{
      const option=e.target.closest('.wheel-option');if(option){if(!suppressWheelClick)adjustWheel(option.closest('.digit-wheel'),Number(option.dataset.offset));return;}
      const x=e.target.closest('button');if(!x)return;
      if(x.matches('.note-trigger')){s.notesOpen=!s.notesOpen;render();markStudyChanged(false);if(s.notesOpen)el.querySelector('.frame-findings').focus();return;}
      if(x.matches('.measurement-collapse')){s.measurementsCollapsed=!s.measurementsCollapsed;render();markStudyChanged(false);return;}
      if(x.matches('.photo-edit')){openPhotoSource(card);return;}
      if(x.matches('.photo-view')){openPhotoViewer(card);return;}
      if(x.matches('.segment-delete')){if(window.confirm(`Delete segment ${s.number} from device run ${run.number}?`)){card.dispose();run.segments.splice(run.segments.indexOf(card),1);el.remove();renderRun(run);markStudyChanged();}return;}
      if(x.matches('.stent-toggle')){s.stentEnabled=!s.stentEnabled;render();markStudyChanged();}else if(x.matches('.collapse-toggle')){s.collapsed=!s.collapsed;render();markStudyChanged(false);}else if(x.matches('[data-target]'))setTarget(x.dataset.target);
    });
    el.addEventListener('wheel',e=>{const w=e.target.closest('.digit-wheel');if(!w)return;e.preventDefault();if(e.deltaY===0)return;adjustWheel(w,e.deltaY>0?1:-1);},{passive:false});
    el.addEventListener('keydown',e=>{const w=e.target.closest('.digit-wheel');if(!w||!['ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();adjustWheel(w,e.key==='ArrowUp'?1:-1);});
    el.addEventListener('pointerdown',e=>{const w=e.target.closest('.digit-wheel');if(!w||measurementDisabled(s,w.dataset.key)||e.button!==0)return;e.preventDefault();w.focus();w.setPointerCapture(e.pointerId);const input=el.querySelector(`.picker-value input[data-key="${w.dataset.key}"][data-diameter="${w.dataset.diameter}"]`);drag={w,id:e.pointerId,y:e.clientY,base:Number(input.value),steps:0,moved:false};w.classList.add('dragging');});
    el.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dy=e.clientY-drag.y,steps=Math.trunc(-dy/32);drag.moved ||= Math.abs(dy)>6;if(steps!==drag.steps){drag.steps=steps;adjustWheel(drag.w,steps,drag.base);}drag.w.querySelector('.wheel-track').style.transform=`translateY(${-32+dy+steps*32}px)`;});
    function endDrag(e,cancel=false){if(!drag||drag.id!==e.pointerId)return;const d=drag;drag=null;if(d.moved&&!cancel)adjustWheel(d.w,Math.round((d.y-e.clientY)/32),d.base);d.w.classList.remove('dragging');d.w.querySelector('.wheel-track').style.transform='';suppressWheelClick=d.moved;setTimeout(()=>{suppressWheelClick=false;},0);}
    el.addEventListener('pointerup',e=>endDrag(e));el.addEventListener('pointercancel',e=>endDrag(e,true));
    render();renderRun(run);
    return card;
  }
  function renderRun(run){
    const el=run.el;
    const timestamp=el.querySelector('.run-created');timestamp.dateTime=run.createdAt;timestamp.textContent='Created '+run.createdLabel;
    el.querySelectorAll('.run-annotations select').forEach(x=>x.value=run[x.dataset.runKey]);
    const summary=`Run ${run.number} · ${run.vessel} · ${stageName(run)} · ${run.modality} · ${run.segments.length} segment${run.segments.length===1?'':'s'}`;
    el.querySelector('.run-summary').textContent=summary;el.querySelector('.run-title').textContent='Device run '+run.number;el.querySelector('.run-count').textContent=run.segments.length+' segment'+(run.segments.length===1?'':'s');
    el.classList.toggle('run-collapsed',run.collapsed);el.querySelector('.run-content').hidden=run.collapsed;
    const toggle=el.querySelector('.run-collapse');toggle.setAttribute('aria-expanded',String(!run.collapsed));toggle.setAttribute('aria-label',(run.collapsed?'Expand':'Collapse')+' device run '+run.number);toggle.setAttribute('aria-controls','run-'+run.number+'-content');el.querySelector('.run-icon').textContent=run.collapsed?'▶':'▼';
    el.querySelector('.run-empty').hidden=run.segments.length>0;
    syncExportControls();document.querySelector('#empty-runs').hidden=runs.length>0;
  }
  function createRun(saved=null){
    const created=new Date();
    const run={createdAt:created.toISOString(),createdLabel:new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(created),number:saved?saved.number:++runSequence,vessel:'LM',phase:'pre',modality:'IVUS',collapsed:false,segmentSequence:0,...saved,segments:[],el:document.createElement('section')};
    runSequence=Math.max(runSequence,run.number);
    run.el.className='device-run';runs.push(run);document.querySelector('#runs').append(run.el);
    const runChoice=(key,label,options)=>choice(key,label,options).replace('data-key=','data-run-key=');
    run.el.innerHTML=`<header class="run-heading"><div class="run-title-block"><span class="panel-index">DEVICE RUN</span><h2 class="run-title"></h2><span class="run-count"></span></div><button type="button" class="run-delete delete-button">Delete</button><button type="button" class="run-collapse"><span class="run-summary"></span><span class="run-icon" aria-hidden="true">▼</span></button></header><time class="run-created"></time><div class="run-content" id="run-${run.number}-content"><div class="run-annotations">${runChoice('vessel','Vessel',vessels.map(v=>[v,v]))}${runChoice('phase','Device stage',stages)}${runChoice('modality','Device',[['IVUS','IVUS'],['OCT','OCT']])}</div><div class="run-segments"></div><p class="run-empty">No segments in this run.</p><button type="button" class="add-run-segment add-segment"><span>+</span> Add segment</button></div>`;
    run.el.querySelector('.run-annotations').addEventListener('change',e=>{if(!e.target.matches('select'))return;run[e.target.dataset.runKey]=e.target.value;run.segments.forEach(card=>card.render());renderRun(run);markStudyChanged();});
    run.el.querySelector('.run-collapse').addEventListener('click',()=>{run.collapsed=!run.collapsed;renderRun(run);markStudyChanged(false);});
    run.el.querySelector('.run-delete').addEventListener('click',()=>{if(!window.confirm(`Delete device run ${run.number} and its ${run.segments.length} segment${run.segments.length===1?'':'s'}?`))return;run.segments.forEach(card=>card.dispose());runs.splice(runs.indexOf(run),1);run.el.remove();syncExportControls();document.querySelector('#empty-runs').hidden=runs.length>0;markStudyChanged();});
    run.el.querySelector('.add-run-segment').addEventListener('click',()=>{createSegment(run);markStudyChanged();});
    if(saved)saved.segments.forEach(segment=>createSegment(run,segment));else createSegment(run);renderRun(run);
  }
  function exportPDF(selectedOnly=false){
    const cards=allCards().filter(card=>!selectedOnly||card.s.selected);if(!cards.length)return;
    if(cards.some(card=>card.s.photoLoading)){document.querySelector('#notice').textContent='Please wait for the photos to finish preparing.';return;}
    // Keep segment order, and give every photo its own page with its diagram.
    const reportPages=[];
    cards.forEach(card=>{const last=reportPages[reportPages.length-1];if(!card.s.photo&&last&&last.length===1&&!last[0].s.photo)last.push(card);else reportPages.push([card]);});
    const streams=[],images=[],continuedNotes=[],patient=document.querySelector('#patient-data').value.trim(),escape=t=>String(t).replace(/[^\x20-\x7e]/g,'-').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
    const measure=document.createElement('canvas').getContext('2d');
    const graphemes=t=>Intl.Segmenter?Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(t),x=>x.segment):Array.from(t);
    function wrapText(value,size=9,width=519){
      measure.font=size+'px Arial, sans-serif';const lines=[];
      for(const paragraph of String(value).replace(/\r\n?/g,'\n').split('\n')){let line='';for(const char of graphemes(paragraph)){if(line&&measure.measureText(line+char).width>width){const split=line.lastIndexOf(' ');if(split>0){lines.push(line.slice(0,split));line=line.slice(split+1)+char;}else{lines.push(line);line=char;}}else line+=char;}lines.push(line.trimEnd());}
      return lines;
    }
    function preview(lines,count,size){const out=lines.slice(0,count);if(lines.length>count){measure.font=size+'px Arial, sans-serif';let chars=graphemes(out[count-1]);const suffix=' [continued in notes]';while(chars.length&&measure.measureText(chars.join('')+suffix).width>519)chars.pop();out[count-1]=chars.join('').trimEnd()+suffix;}return out;}
    function drawText(commands,x,y,value,size=10){
      const t=String(value);if(!/[^\x20-\x7e]/.test(t)){commands.push(`BT /F1 ${size} Tf 0.12 0.20 0.27 rg ${x} ${y} Td (${escape(t)}) Tj ET`);return;}
      const scale=3,c=document.createElement('canvas'),context=c.getContext('2d');measure.font=size+'px Arial, sans-serif';c.width=Math.ceil((measure.measureText(t).width+2)*scale);c.height=Math.ceil(size*1.6*scale);context.fillStyle='#fff';context.fillRect(0,0,c.width,c.height);context.font=size*scale+'px Arial, sans-serif';context.fillStyle='#1f3345';context.textBaseline='alphabetic';context.fillText(t,scale,size*1.25*scale);
      const encoded=atob(c.toDataURL('image/jpeg',.98).split(',')[1]),bytes=Uint8Array.from(encoded,char=>char.charCodeAt(0)),name='Note'+images.length;images.push({name,bytes,width:c.width,height:c.height});commands.push(`q ${c.width/scale} 0 0 ${c.height/scale} ${x} ${y-size*.35} cm /${name} Do Q`);
    }
    const patientLines=patient?wrapText('Patient data: '+patient,9):[];
    if(patientLines.length>2)continuedNotes.push({label:'Patient data',value:patient});
    const percent=(s,value,requiresReference=true)=>!valid(s)?'Check areas':requiresReference&&!ready(s)?'N/A':value.toFixed(1)+'%';
    for(const pageCards of reportPages){
      const commands=[];
      const text=(x,y,t,size=10)=>drawText(commands,x,y,t,size);
      const line=y=>commands.push(`0.82 0.87 0.90 RG 1 w 38 ${y} m 557 ${y} l S`);
      const circle=(x,y,r,type)=>{
        const styles={eem:['0.89 0.57 0.32',null,'[]'],plaque:['0.76 0.42 0.27','0.93 0.78 0.66','[]'],tissue:['0.76 0.42 0.27','0.76 0.55 0.42','[]'],lumen:['0.12 0.60 0.53','0.14 0.25 0.30','[]'],stent:['1 1 1',null,'[5 4]'],reference:['0.48 0.62 0.68',null,'[2 3]'],target:['0.22 0.88 0.76',null,'[]'],background:['0.08 0.18 0.25','0.08 0.18 0.25','[]']};
        const [stroke,fill,dash]=styles[type],k=r*.5522847498,n=v=>v.toFixed(3);
        commands.push(`q ${stroke} RG 2 w ${dash} 0 d ${fill?fill+' rg':''} ${n(x+r)} ${n(y)} m ${n(x+r)} ${n(y+k)} ${n(x+k)} ${n(y+r)} ${n(x)} ${n(y+r)} c ${n(x-k)} ${n(y+r)} ${n(x-r)} ${n(y+k)} ${n(x-r)} ${n(y)} c ${n(x-r)} ${n(y-k)} ${n(x-k)} ${n(y-r)} ${n(x)} ${n(y-r)} c ${n(x+k)} ${n(y-r)} ${n(x+r)} ${n(y-k)} ${n(x+r)} ${n(y)} c ${fill?'B':'S'} Q`);
      };

      text(38,804,'DEVICE RUN REPORT',19);if(patient){preview(patientLines,2,9).forEach((t,i)=>text(38,780-i*16,t,9));line(754);}else line(784);
      pageCards.forEach(({s,run},slot)=>{
        const top=(patient?730:760)-slot*355,st=hasStent(s),reportPlanning=st&&s.planning&&!['initial','final'].includes(s.phase),reportState={...s,planning:reportPlanning};
        text(38,top,`Run ${run.number} / Segment ${s.number} - ${s.vessel} / ${s.segment}`,14);
        text(38,top-20,`${s.modality} | Target: ${targetName(s)} | ${stageName(s)}`,9);
        text(38,top-33,'Run created: '+run.createdLabel,8);
        text(38,top-49,'MEASUREMENTS',8);text(210,top-49,'Area / equivalent diameter',8);
        let y=top-68;
        const row=(label,value)=>{text(38,y,label,9);text(210,y,value,10);y-=24;};
        row('Lumen',`${fmt(lumenArea(s))} mm2 / ${fmt(diameter(lumenArea(s)))} mm`);
        row('Stent',st?`${fmt(s.stent)} mm2 / ${fmt(diameter(s.stent))} mm`:'Off - no stent in this frame');
        row('Reference ('+referenceShort(s)+')',ready(s)?`${fmt(reference(s))} mm2 / ${fmt(diameter(reference(s)))} mm`:'Not entered');
        if(canSelectProlapse(s))text(38,top-166,s.plaqueProlapse==='none'?'No plaque prolapse (no PP) - lumen equals stent':'Plaque prolapse (PP)',8);
        circle(474,top-101,62,'background');const rings=diagramSpec(reportState);rings.forEach(r=>circle(474,top-101,r.r*.60,r.type));
        text(415,top-178,'SCHEMATIC CONTOURS',7);text(405,top-191,ready(s)?referenceShort(s)+' reference / green lumen':'Reference not entered / green lumen',7);if(st)text(405,top-202,'White dashed: measured stent',7);if(reportPlanning&&ready(s))text(405,top-213,'Green outline: desired stent',7);if(canSelectProlapse(s))text(405,top-213,'Plaque prolapse: '+percent(s,tissueBurden(s),false),7);
        if(!valid(s))text(38,top-209,'Check inconsistent measurement areas.',9);
        const metrics=[[mainLabel(s),percent(s,st?expansion(s):burden(s))]];
        if(st){metrics.push([tissueLabel(s),percent(s,tissueBurden(s),false)]);if(s.referenceType==='eem'){metrics.push(['Outside-stent plaque burden',s.stent<=reference(s)?percent(s,outsideBurden(s)):'N/A'],['Total plaque burden',percent(s,burden(s))]);}}
        metrics.forEach(([label,value],j)=>{const x=38+(j%2)*263,y=top-231-Math.floor(j/2)*33;text(x,y,label,8);text(x,y-16,value,15);});
        if(reportPlanning&&ready(s))text(38,top-296,`Desired: ${s.target}% | ${fmt(targetArea(s))} mm2 | ${fmt(diameter(targetArea(s)))} mm equivalent`,9);
        if(s.findings.trim()){const lines=wrapText(s.findings.trim(),8);text(38,top-306,'FRAME FINDINGS',8);preview(lines,2,8).forEach((t,i)=>text(38,top-319-i*14,t,8));if(lines.length>2)continuedNotes.push({label:`Run ${run.number} / Segment ${s.number} - Frame findings`,value:s.findings.trim()});}
        if(s.photo){
          const photoTop=Math.min(404,top-349),boxHeight=photoTop-71;
          line(photoTop);text(38,photoTop-16,`${s.modality} FRAME PHOTO - Run ${run.number} / Segment ${s.number}`,9);
          const encoded=atob(s.photo.dataUrl.split(',')[1]),bytes=Uint8Array.from(encoded,char=>char.charCodeAt(0)),name='Photo'+images.length;
          images.push({name,bytes,width:s.photo.width,height:s.photo.height});
          const scale=Math.min(519/s.photo.width,boxHeight/s.photo.height),width=s.photo.width*scale,height=s.photo.height*scale,x=38+(519-width)/2,y=42+(boxHeight-height)/2;
          commands.push(`q ${width} 0 0 ${height} ${x} ${y} cm /${name} Do Q`);
        }
        if(slot===0&&pageCards.length===2)line(top-338);
      });
      streams.push(commands.join('\n'));
    }
    if(continuedNotes.length){
      let commands=[],y=0;const startPage=()=>{commands=[];drawText(commands,38,804,'PATIENT DATA & FRAME FINDINGS',18);y=766;};const finishPage=()=>streams.push(commands.join('\n'));startPage();
      for(const note of continuedNotes){if(y<112){finishPage();startPage();}drawText(commands,38,y,note.label,12);y-=24;for(const line of wrapText(note.value,10)){if(y<58){finishPage();startPage();drawText(commands,38,y,note.label+' (continued)',12);y-=24;}drawText(commands,38,y,line,10);y-=18;}y-=18;}
      finishPage();
    }
    const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>',null,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],ids=[];
    images.forEach(img=>{const id=objects.length;img.objectId=id;objects.push({dictionary:`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>`,bytes:img.bytes});});
    streams.forEach((stream,i)=>{stream+=`\nBT /F1 8 Tf 0.12 0.20 0.27 rg 478 23 Td (Page ${i+1} of ${streams.length}) Tj ET`;const id=objects.length;ids.push(id);objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> /XObject << ${images.filter(img=>stream.includes('/'+img.name+' Do')).map(img=>'/'+img.name+' '+img.objectId+' 0 R').join(' ')} >> >> /Contents ${id+1} 0 R >>`,`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);});
    objects[2]=`<< /Type /Pages /Kids [${ids.map(id=>id+' 0 R').join(' ')}] /Count ${streams.length} >>`;
    const chunks=[],offsets=[0],encoder=new TextEncoder();let length=0;const add=value=>{const bytes=typeof value==='string'?encoder.encode(value):value;chunks.push(bytes);length+=bytes.length;};add('%PDF-1.4\n');
    for(let i=1;i<objects.length;i++){offsets.push(length);add(`${i} 0 obj\n`);if(typeof objects[i]==='string')add(objects[i]+'\n');else{add(objects[i].dictionary+'\nstream\n');add(objects[i].bytes);add('\nendstream\n');}add('endobj\n');}
    const start=length;add(`xref\n0 ${objects.length}\n0000000000 65535 f \n`+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
    const url=URL.createObjectURL(new Blob(chunks,{type:'application/pdf'})),link=document.createElement('a');link.href=url;link.download=selectedOnly?'device-run-selected-report.pdf':'device-run-report.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);const runCount=new Set(cards.map(card=>card.run)).size;document.querySelector('#notice').textContent=(selectedOnly?'Selected PDF':'PDF')+' exported with '+runCount+' device run'+(runCount===1?'':'s')+' and '+cards.length+' segment'+(cards.length===1?'':'s')+'.';
  }
  document.querySelector('#add-run').addEventListener('click',()=>{createRun();markStudyChanged();});document.querySelector('#export').addEventListener('click',()=>{closeNavigation();exportPDF(false);document.querySelector('#app-menu-toggle').focus({preventScroll:true});});document.querySelector('#export-selected').addEventListener('click',()=>{closeNavigation();exportPDF(true);document.querySelector('#app-menu-toggle').focus({preventScroll:true});});
  document.querySelector('#select-all').addEventListener('click',()=>{allCards().forEach(card=>{card.s.selected=true;card.render();});syncExportControls();markStudyChanged(false);});
  document.querySelector('#clear-selection').addEventListener('click',()=>{allCards().forEach(card=>{card.s.selected=false;card.render();});syncExportControls();markStudyChanged(false);});
  document.querySelector('#patient-data-toggle').addEventListener('click',()=>{const input=document.querySelector('#patient-data'),open=input.hidden;showPatientData(open);if(open)input.focus();});
  document.querySelector('#patient-data').addEventListener('input',()=>{showPatientData(true);markStudyChanged();});
  document.querySelector('#new-exam').addEventListener('click',newExam);
  document.querySelector('#back-records').addEventListener('click',showRecords);
  document.querySelector('#records-current').addEventListener('click',()=>openStudy(currentExamId));
  document.querySelector('#menu-exam').addEventListener('click',()=>openStudy(currentExamId));
  document.querySelector('#menu-records').addEventListener('click',showRecords);
  document.querySelector('#retry-save').addEventListener('click',()=>flushStudy());
  document.querySelector('#reload-study').addEventListener('click',reloadSavedStudy);
  document.querySelector('#record-search').addEventListener('input',renderRecords);
  document.querySelector('#record-list').addEventListener('click',event=>{
    const open=event.target.closest('[data-open-study]'),remove=event.target.closest('[data-delete-study]');
    if(open)void openStudy(open.dataset.openStudy);else if(remove)void deleteStudy(remove.dataset.deleteStudy);
  });
  document.querySelector('#app-menu-toggle').addEventListener('click',()=>{
    const menu=document.querySelector('#app-menu'),button=document.querySelector('#app-menu-toggle');menu.hidden=!menu.hidden;button.setAttribute('aria-expanded',String(!menu.hidden));if(!menu.hidden)menu.querySelector('button:not([hidden]):not(:disabled)').focus();
  });
  document.addEventListener('click',event=>{if(!event.target.closest('.app-menu-wrap'))closeNavigation();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('#app-menu').hidden){closeNavigation();document.querySelector('#app-menu-toggle').focus();}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void flushStudy();});
  window.addEventListener('pagehide',()=>{void flushStudy();});
  window.addEventListener('beforeunload',event=>{if(dirty||allCards().some(card=>card.s.photoLoading)){event.preventDefault();event.returnValue='';}});
  initializeStudies();
})();
