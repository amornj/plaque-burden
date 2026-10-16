(() => {
  let opening;
  const databaseName='plaque-burden-studies';
  function database(){
    if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      const request=indexedDB.open(databaseName,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        db.createObjectStore('studies',{keyPath:'id'});
        db.createObjectStore('studyIndex',{keyPath:'id'});
        const photos=db.createObjectStore('photos',{keyPath:'id'});photos.createIndex('studyId','studyId');
        db.createObjectStore('settings',{keyPath:'key'});
      };
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
      request.onerror=()=>{opening=null;reject(request.error);};
      request.onblocked=()=>{opening=null;reject(new Error('Close other app tabs, then retry saving.'));};
    });
    opening=opening.catch(error=>{opening=null;throw error;});
    return opening;
  }
  async function read(store,key){
    const db=await database();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(store,'readonly'),request=key===undefined?tx.objectStore(store).getAll():tx.objectStore(store).get(key);
      let result;request.onsuccess=()=>result=request.result;
      tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Unable to read saved studies.'));
    });
  }
  async function load(id){
    const study=await read('studies',id);if(!study)return null;
    const ids=study.runs.flatMap(run=>run.segments.map(segment=>segment.photo?.id).filter(Boolean));
    return {study,photos:await readPhotos(ids)};
  }
  async function readPhotos(ids){
    const photos=await Promise.all(ids.map(id=>read('photos',id)));
    return new Map(photos.filter(Boolean).map(photo=>[photo.id,photo]));
  }
  function indexEntry(study){
    const segments=study.runs.flatMap(run=>run.segments);
    return {id:study.id,createdAt:study.createdAt,updatedAt:study.updatedAt,patientData:study.patientData,hasContent:study.hasContent,recovered:!!study.recovered,recoveryWarning:study.recoveryWarning||'',runCount:study.runs.length,segmentCount:segments.length,photoCount:segments.filter(s=>s.photo).length,devices:[...new Set(study.runs.map(run=>run.modality))],vessels:[...new Set(study.runs.map(run=>run.vessel))]};
  }
  async function save(study,photos,expectedRevision,setCurrent){
    const db=await database();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['studies','studyIndex','photos','settings'],'readwrite',{durability:'strict'});
      let failure;
      const request=tx.objectStore('studies').get(study.id);
      request.onsuccess=()=>{
        const existing=request.result;
        if(!existing&&expectedRevision>0){failure=Object.assign(new Error('This study was deleted in another tab.'),{code:'deleted'});tx.abort();return;}
        if((existing?.revision??0)!==expectedRevision){failure=Object.assign(new Error('This study was changed in another tab.'),{code:'conflict'});tx.abort();return;}
        tx.objectStore('studies').put(study);tx.objectStore('studyIndex').put(indexEntry(study));
        const photoStore=tx.objectStore('photos'),used=new Set(study.runs.flatMap(run=>run.segments.map(s=>s.photo?.id).filter(Boolean)));
        const old=photoStore.index('studyId').getAllKeys(study.id);
        old.onsuccess=()=>old.result.forEach(id=>{if(!used.has(id))photoStore.delete(id);});
        photos.forEach(photo=>photoStore.put({...photo,studyId:study.id}));
        if(setCurrent)tx.objectStore('settings').put({key:'currentExam',value:study.id});
      };
      tx.oncomplete=()=>resolve(study.revision);
      tx.onerror=tx.onabort=()=>reject(failure||tx.error||new Error('Unable to save on this device.'));
    });
  }
  async function remove(id){
    const db=await database();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['studies','studyIndex','photos','settings'],'readwrite',{durability:'strict'});
      tx.objectStore('studies').delete(id);tx.objectStore('studyIndex').delete(id);
      const photos=tx.objectStore('photos'),keys=photos.index('studyId').getAllKeys(id);
      keys.onsuccess=()=>keys.result.forEach(key=>photos.delete(key));
      const setting=tx.objectStore('settings').get('currentExam');setting.onsuccess=()=>{if(setting.result?.value===id)tx.objectStore('settings').delete('currentExam');};
      tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Unable to delete this study.'));
    });
  }
  window.StudyStore={database,load,readPhotos,save,remove,list:()=>read('studyIndex'),current:async()=>(await read('settings','currentExam'))?.value};
})();
