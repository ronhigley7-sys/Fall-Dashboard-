// Zoom meeting incident review for Fall Dashboard
(function(){
  let reviewIndex=0;
  const reviewed=new Set();

  function rows(){
    if(typeof getF!=='function') return [];
    return getF().slice().sort((a,b)=>((b._d&&b._d.getTime())||0)-((a._d&&a._d.getTime())||0));
  }
  function key(r){
    return [r.facility||'',r.unit||'',String(r.eventDate||''),String(r.eventTime||'')].join('|').toLowerCase().trim();
  }
  function check(label,value){
    const t=(value==null?'':String(value)).trim().toLowerCase();
    const ok=!!t&&(t.includes('complet')||t==='yes');
    return `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #EEF1F6"><span style="font-size:12px">${label}</span><span style="font-size:12px;font-weight:800;color:${ok?'#27AE60':'#C0392B'}">${ok?'✓ Complete':'⚠ Review'}</span></div>`;
  }
  function ensureUI(){
    if(document.getElementById('tab-zoomreview')) return;
    const incBtn=document.getElementById('incTabBtn');
    if(incBtn){
      const b=document.createElement('button');
      b.className='tab-btn'; b.id='zoomTabBtn'; b.textContent='🎥 Zoom Review';
      b.onclick=function(){ showTab('zoomreview',b); };
      incBtn.insertAdjacentElement('afterend',b);
    }
    const content=document.getElementById('content');
    if(content){
      const pane=document.createElement('div');
      pane.id='tab-zoomreview'; pane.className='tab-pane';
      pane.innerHTML=`
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <div><div style="font-weight:800;font-size:18px;color:#1B2A4A">Fall Incident Zoom Review</div><div id="zoomReviewSubtitle" style="font-size:12px;color:#5E6E8C;margin-top:3px"></div></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-teal" id="zoomPrevBtn">← Previous</button><button class="btn-teal" id="zoomNextBtn">Next →</button><button class="btn-red" id="zoomResetBtn">Reset Reviewed</button></div>
        </div>
        <div id="zoomReviewKPIs" style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px"></div>
        <div class="card" style="padding:10px 14px"><div style="display:flex;align-items:center;gap:10px"><div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#5E6E8C;white-space:nowrap">Meeting Progress</div><div class="bar-track" style="flex:1;height:10px;margin:0"><div id="zoomProgressBar" class="bar-fill" style="width:0%;background:#0E7C7B"></div></div><div id="zoomProgressText" style="font-size:12px;font-weight:800;white-space:nowrap">0 / 0 reviewed</div></div></div>
        <div id="zoomReviewCard"></div><div id="zoomReviewQueue" class="card" style="margin-top:14px"></div>`;
      const upload=document.getElementById('tab-upload');
      if(upload) content.insertBefore(pane,upload); else content.appendChild(pane);
      document.getElementById('zoomPrevBtn').onclick=prev;
      document.getElementById('zoomNextBtn').onclick=next;
      document.getElementById('zoomResetBtn').onclick=function(){reviewed.clear();reviewIndex=0;render();};
    }
  }
  function prev(){const r=rows();if(!r.length)return;reviewIndex=(reviewIndex-1+r.length)%r.length;render(r);}
  function next(){const r=rows();if(!r.length)return;reviewIndex=(reviewIndex+1)%r.length;render(r);}
  function jump(i){reviewIndex=i;render();document.getElementById('zoomReviewCard')?.scrollIntoView({behavior:'smooth',block:'start'});}
  function toggle(){const r=rows();if(!r.length)return;if(reviewIndex>=r.length)reviewIndex=0;const k=key(r[reviewIndex]);reviewed.has(k)?reviewed.delete(k):reviewed.add(k);render(r);}

  function render(arg){
    ensureUI();
    const r=Array.isArray(arg)?arg:rows();
    const card=document.getElementById('zoomReviewCard'), queue=document.getElementById('zoomReviewQueue'), kpis=document.getElementById('zoomReviewKPIs');
    if(!card||!queue||!kpis)return;
    if(reviewIndex>=r.length) reviewIndex=Math.max(0,r.length-1);
    const done=r.filter(x=>reviewed.has(key(x))).length;
    const injuries=r.filter(x=>['Minor','Moderate','Major'].includes(x.injuryLevel)).length;
    const huddles=r.filter(x=>(x.huddleCompleted||'').toString().toLowerCase().includes('yes')).length;
    const unassisted=r.filter(x=>{const v=(x.assisted||'').toString().toLowerCase();return v.includes('no')||v.includes('unassist');}).length;
    const tab=document.getElementById('zoomTabBtn');if(tab)tab.textContent=`🎥 Zoom Review (${r.length})`;
    kpis.innerHTML=[['Incidents',r.length,'In meeting review','#1B2A4A'],['With Injury',injuries,'Minor / Moderate / Major',injuries?'#C0392B':'#27AE60'],['Huddles Done',`${huddles}/${r.length||0}`,'Post-fall huddle',huddles===r.length?'#27AE60':'#E67E22'],['Unassisted',unassisted,'Potential prevention focus',unassisted?'#E67E22':'#27AE60']].map(x=>`<div class="kpi" style="border-top:4px solid ${x[3]}"><div class="kpi-label">${x[0]}</div><div class="kpi-value" style="font-size:22px;color:${x[3]}">${x[1]}</div><div class="kpi-sub">${x[2]}</div></div>`).join('');
    const pct=r.length?Math.round(done/r.length*100):0;
    document.getElementById('zoomProgressBar').style.width=pct+'%';
    document.getElementById('zoomProgressText').textContent=`${done} / ${r.length} reviewed`;
    document.getElementById('zoomReviewSubtitle').textContent=`Meeting-ready review · ${typeof fUnit!=='undefined'&&fUnit!=='ALL'?fUnit:'All units'} · ${typeof fMonth!=='undefined'&&fMonth!=='ALL'?fMonth:'All months'}`;
    if(!r.length){card.innerHTML='<div class="card" style="text-align:center;padding:40px;color:#5E6E8C">No incidents match the current filters.</div>';queue.innerHTML='';return;}
    const inc=r[reviewIndex], isDone=reviewed.has(key(inc));
    const summary=typeof generateSummary==='function'?generateSummary(inc,reviewIndex):`${inc.unit||''} ${inc.eventDate||''} ${inc.causeOfFall||''}`;
    const injuryColor=(typeof INJC!=='undefined'&&INJC[inc.injuryLevel])||'#5E6E8C';
    const discussion=[['What happened?',inc.eventDescription||`${inc.activityAtFall||'Activity not documented'} · ${inc.causeOfFall||'Cause not documented'}`],['Immediate injury / outcome',inc.injuryLevel||'Not documented'],['Risk picture',`${inc.fallRiskLevel||'Risk level not documented'}${inc.morseScore?' · Morse '+inc.morseScore:''}${inc.jhHlmScore?' · JH-HLM '+inc.jhHlmScore:''}`],['Staff involved',`RN: ${inc.primaryRN||'—'} · UAP/CA: ${inc.primaryUAP||'—'}`],['Recommendations / action',inc.recommendations||inc.pertinentNotes||'No recommendation documented']];
    card.innerHTML=`<div class="slide" style="border:2px solid ${isDone?'#27AE60':'#D0DAE8'}"><div class="slide-hdr" style="padding:14px 16px"><div class="slide-num" style="background:${injuryColor};width:38px;height:38px">${reviewIndex+1}</div><div class="slide-hdr-text"><div class="slide-title" style="font-size:16px">${inc.unit||'—'} · ${inc.eventDate||'—'} ${inc.eventTime||''}</div><div class="slide-sub">${inc.patientInitials||'—'} · ${inc.injuryLevel||'Unknown injury'} · ${inc.causeOfFall||'Cause not documented'}</div></div><button id="zoomMarkBtn" style="border-radius:6px;padding:8px 12px;font-weight:800;cursor:pointer;background:${isDone?'#27AE60':'#fff'};color:${isDone?'#fff':'#27AE60'};border:1px solid #27AE60;white-space:nowrap">${isDone?'✓ Reviewed':'Mark Reviewed'}</button></div><div style="background:#EEF6FF;border-bottom:1px solid #C8DDEF;padding:14px 16px"><div style="font-size:9px;color:#253660;font-weight:800;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Meeting Summary</div><div style="font-size:13px;line-height:1.65">${summary}</div></div><div class="slide-body" style="grid-template-columns:1.15fr .85fr"><div><div style="font-size:10px;color:#5E6E8C;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Discussion Guide</div>${discussion.map(x=>`<div class="rec-box" style="margin-bottom:8px"><div class="rec-title">${x[0]}</div><div class="rec-text">${x[1]}</div></div>`).join('')}<div class="rec-box" style="background:#FFF9E8;border-color:#E2C46A"><div class="rec-title">Questions for the Team</div><div class="rec-text">What could have prevented this fall? Was the prevention plan in place? What should we repeat, change, or escalate? Who owns the follow-up action?</div></div></div><div><div style="font-size:10px;color:#5E6E8C;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Post-Fall Checklist</div>${check('Post-fall vitals',inc.postFallVitals)}${check('Pain assessment',inc.painAssessment)}${check('Neuro assessment',inc.neuroAssessment)}${check('Skin assessment',inc.skinAssessment)}${check('Fall log flowsheet',inc.fallLogFlowsheet)}${check('Huddle completed',inc.huddleCompleted)}<div style="margin-top:14px;padding:10px;border-radius:6px;background:#F7F9FC;border:1px solid #D0DAE8"><div style="font-size:10px;font-weight:800;color:#5E6E8C;text-transform:uppercase;margin-bottom:5px">RL Status</div><div style="font-size:13px;font-weight:800;color:${(inc.rlEntered||'').toString().toLowerCase().includes('yes')?'#27AE60':'#C0392B'}">${inc.rlEntered||'Not documented'}</div></div></div></div></div>`;
    document.getElementById('zoomMarkBtn').onclick=toggle;
    queue.innerHTML=`<div class="card-title">Meeting Queue</div><div style="display:flex;gap:7px;flex-wrap:wrap">${r.map((x,i)=>{const d=reviewed.has(key(x)),a=i===reviewIndex;return `<button data-zi="${i}" style="cursor:pointer;border-radius:6px;padding:6px 9px;font-size:11px;font-weight:800;border:1px solid ${a?'#1B2A4A':d?'#27AE60':'#D0DAE8'};background:${a?'#1B2A4A':d?'#EAF8EF':'#fff'};color:${a?'#fff':d?'#27AE60':'#1B2A4A'}">${d?'✓ ':''}${i+1}</button>`;}).join('')}</div>`;
    queue.querySelectorAll('[data-zi]').forEach(b=>b.onclick=()=>jump(parseInt(b.dataset.zi,10)));
  }

  function install(){
    ensureUI();
    if(typeof showTab==='function'&&!showTab._zoomWrapped){
      const base=showTab;
      window.showTab=function(id,btn){base(id,btn);if(id==='zoomreview')render();};
      window.showTab._zoomWrapped=true;
    }
    if(typeof applyFilters==='function'&&!applyFilters._zoomWrapped){const base=applyFilters;window.applyFilters=function(){base();if(document.getElementById('tab-zoomreview')?.classList.contains('active'))render();};window.applyFilters._zoomWrapped=true;}
    if(typeof setUnitFilter==='function'&&!setUnitFilter._zoomWrapped){const base=setUnitFilter;window.setUnitFilter=function(u){base(u);if(document.getElementById('tab-zoomreview')?.classList.contains('active'))render();};window.setUnitFilter._zoomWrapped=true;}
    render();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
