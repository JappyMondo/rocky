/** THROWAWAY: compare nested attachments, a flat cluster, and an agent workspace on /profiles?prototype=ai&variant=A. */
import { useEffect, useState } from 'react';
const variants = ['A · Connected assistants', 'B · Flat cluster', 'C · Agent workspace'];
const cards = [
  ['plan', '◇', 'Plan implementation', 'Delivery'],
  ['implement', '◇', 'Implement & open draft', 'Coordinator'],
  ['validate', '✓', 'Validate commands', 'Delivery'],
  ['agent', '✦', 'Implementation agent', 'AI agent'],
  ['model', '◈', 'Implementation model', 'Model · from profile'],
  ['prompt', '≡', 'Implementation instructions', 'Prompt · implementer.md'],
  ['tools', '>_', 'Workspace tools', 'Read · Edit · Shell'],
  ['mcp', '⌘', 'Connected services', 'MCP tools'],
];
export function ModularFlowPrototype() {
  const [variant, setVariant] = useState(Math.max(0, 'ABC'.indexOf(new URLSearchParams(location.search).get('variant') ?? 'A')));
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState('agent');
  const [prompt, setPrompt] = useState('Implement the agreed plan. Work in the issue branch, verify the result and report what changed.');
  const cycle = (direction: number) => setVariant(current => {
    const next = (current + direction + 3) % 3;
    const url = new URL(location.href); url.searchParams.set('variant', 'ABC'[next]); history.replaceState(null, '', url);
    return next;
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,[contenteditable]')) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, []);
  const positions = variant === 0 ? [[70,50],[390,50],[710,50],[390,235],[40,450],[300,450],[560,450],[820,450]] : [[40,50],[390,50],[740,50],[60,260],[300,260],[540,260],[780,260],[390,465]];
  const links = variant === 0 ? [[0,1,'flow'],[1,2,'flow'],[3,1,'Agent'],[4,3,'Model'],[5,3,'Prompt'],[6,3,'Tools'],[7,3,'Tools']] : [[0,1,'flow'],[1,2,'flow'],[3,1,'Agent'],[4,1,'Model'],[5,1,'Prompt'],[6,1,'Tools'],[7,1,'Tools']];
  const active = cards.find(c => c[0] === selected)!;
  return <section style={{border:'1px solid var(--border)',borderRadius:12,overflow:'auto',background:'white',...(expanded?{position:'fixed',inset:16,zIndex:100}: {})}}>
    <header style={{display:'flex',justifyContent:'space-between',padding:20,borderBottom:'1px solid var(--border)'}}><div><strong>Issue to delivery</strong><div style={{fontSize:12,color:'var(--muted)',marginTop:5}}>Modular AI · Design preview · No changes are saved</div></div><div><button onClick={()=>setExpanded(!expanded)}>{expanded?'Exit full screen':'Full screen'}</button> <button onClick={()=>setSelected('agent')}>+ Connect component</button></div></header>
    {variant === 2 ? <div style={{display:'grid',gridTemplateColumns:'220px 1fr',minHeight:580}}><nav style={{padding:20,background:'var(--sidebar)'}}>{cards.slice(0,3).map(c=><button key={c[0]} onClick={()=>setSelected(c[0])} style={{display:'block',width:'100%',marginBottom:12}}>{c[1]} {c[2]}</button>)}</nav><div style={{padding:30}}><small>IMPLEMENT & OPEN DRAFT</small><h2>Implementation agent</h2><p>Choose who does the work and what they can use.</p><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>{cards.slice(4).map(c=><button key={c[0]} onClick={()=>setSelected(c[0])} style={{textAlign:'left',padding:25}}><strong>{c[1]} {c[2]}</strong><p>{c[3]}</p><small>Change connection →</small></button>)}</div><p>Selected: {active[2]}</p><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} style={{width:'100%',minHeight:110}}/></div></div> : <div style={{display:'flex',minHeight:610}}><div style={{position:'relative',flex:1,minWidth:0,overflow:'auto',background:'radial-gradient(#cbd3c4 1px,transparent 1px)',backgroundSize:'20px 20px'}}><div style={{position:'relative',width:1080,height:610}}><svg width="1080" height="610" style={{position:'absolute'}}>{links.map(([s,t,label],i)=>{
      const a=positions[Number(s)],b=positions[Number(t)],flow=label==='flow'; const x=flow?a[0]+205:a[0]+102,y=flow?a[1]+35:a[1],tx=flow?b[0]:b[0]+102,ty=flow?b[1]+35:b[1]+70;
      return <g key={i}><path d={`M${x},${y} C${x},${(y+ty)/2} ${tx},${(y+ty)/2} ${tx},${ty}`} fill="none" stroke="#668559" strokeWidth="1.7" strokeDasharray={flow?undefined:'5 5'}/>{!flow&&<text x={(x+tx)/2+8} y={(y+ty)/2} fill="#526c42" fontSize="11">{label}</text>}</g>;
    })}</svg>{cards.map((c,i)=><button key={c[0]} onClick={()=>setSelected(c[0])} style={{position:'absolute',left:positions[i][0],top:positions[i][1],width:205,minHeight:70,textAlign:'left',padding:14,display:'flex',gap:10,background:selected===c[0]?'#f1f5eb':'white',border:`1.5px solid ${selected===c[0]?'#365c42':'#c6d0be'}`,borderRadius:i>2?18:10,boxShadow:'0 3px 8px #293d2110'}}><span style={{fontSize:25,color:'#526c42'}}>{c[1]}</span><span><strong style={{fontSize:12}}>{c[2]}</strong><small style={{display:'block',fontSize:10,color:'#727b71',marginTop:4}}>{c[3]}</small></span></button>)}</div></div><aside style={{width:275,padding:20,borderLeft:'1px solid var(--border)'}}><strong>{active[2]}</strong><p style={{fontSize:12,color:'var(--muted)'}}>{active[3]}</p>{selected==='agent'?<><p>The coordinator passes the plan to this agent. Connect the model, instructions and tools it should use.</p>{['Model','Prompt','Tools'].map(s=><button key={s} style={{width:'100%',marginBottom:10}} onClick={()=>setSelected(s.toLowerCase())}>{s} →</button>)}</>:<><label style={{display:'block',fontSize:12,marginBottom:8}}>Configuration</label><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} style={{width:'100%',minHeight:180}}/></>}</aside></div>}
    <details style={{padding:16}}><summary>Prototype state</summary><pre>{JSON.stringify({variant:'ABC'[variant],selected,prompt,connections:links},null,2)}</pre></details>
    {import.meta.env.DEV&&<div style={{position:'fixed',bottom:20,left:'50%',transform:'translateX(-50%)',display:'flex',alignItems:'center',gap:20,background:'#28342f',color:'white',borderRadius:30,padding:'10px 14px',zIndex:200,boxShadow:'0 5px 30px #28342f40'}}><button style={{color:'#28342f'}} onClick={()=>cycle(-1)}>←</button><span>{variants[variant]}</span><button style={{color:'#28342f'}} onClick={()=>cycle(1)}>→</button></div>}
  </section>;
}
