type InstallPrompt=Event & {prompt():Promise<void>;userChoice:Promise<{outcome:string}>};
/** Installation is optional. No background sync, cached API responses, or write replay. */
export function initPwa(){
 if(typeof window==='undefined'||typeof navigator==='undefined'||!('serviceWorker' in navigator)||!window.isSecureContext)return;
 void navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).catch(()=>{/* The online application remains usable if installation is unavailable. */});
 let prompt:InstallPrompt|null=null;
 const button=document.createElement('button');button.type='button';button.className='button secondary install-app-button';button.textContent='Install OrderTruth';button.hidden=true;
 const status=document.createElement('p');status.className='install-app-status';status.setAttribute('role','status');status.hidden=true;
 document.body.append(button,status);
 window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event as InstallPrompt;button.hidden=false;});
 button.addEventListener('click',()=>{if(!prompt)return;const current=prompt;prompt=null;button.hidden=true;void current.prompt().then(()=>current.userChoice).then(choice=>{if(choice.outcome==='accepted'){status.textContent='OrderTruth installed. Case and recovery actions still require a live connection.';status.hidden=false;setTimeout(()=>{status.hidden=true;},8000);}}).catch(()=>{});});
 window.addEventListener('appinstalled',()=>{prompt=null;button.hidden=true;});
}
