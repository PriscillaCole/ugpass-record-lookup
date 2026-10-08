const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const {Writable} = require('node:stream');
const ROOT = __dirname;
const URL = 'https://portal.ugpass.go.ug/admin-portal/subscriber/searchsubscriber';
const inputBytes = fs.readFileSync(path.join(ROOT,'records.json'));
const input = JSON.parse(inputBytes);
const fingerprint = crypto.createHash('sha256').update(inputBytes).digest('hex');
const limitArg = process.argv.find(x=>x.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 5;
if (!Number.isSafeInteger(LIMIT) || LIMIT < 1) throw new Error('Use --limit=5 or --limit=2269.');
const TODAY = new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Kampala',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date());
const RANGE = `01/10/2024 - ${TODAY}`;
const checkpointPath = path.join(ROOT,'progress.json');
let state = fs.existsSync(checkpointPath) ? JSON.parse(fs.readFileSync(checkpointPath,'utf8')) : {fingerprint,range:RANGE,results:{}};
if (state.fingerprint !== fingerprint || state.range !== RANGE) throw new Error('Input or run date changed. Rename progress.json before starting a new run. Existing results are preserved.');
let muted=false;
const output=new Writable({write(chunk,encoding,done){if(!muted)process.stdout.write(chunk);done();}});
output.isTTY=process.stdout.isTTY;
const rl = readline.createInterface({input:process.stdin,output,terminal:Boolean(process.stdin.isTTY)});
async function secret(prompt) {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal.');
  muted=true;
  try { return await rl.question(''); }
  finally {muted=false;process.stdout.write('\n');}
}
function csv(value) {
  let s=String(value??'');
  // Prevent spreadsheet formula execution from source strings.
  if (/^[=+@-]/.test(s)) s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}
function save() {
  fs.writeFileSync(checkpointPath+'.tmp',JSON.stringify(state,null,2));
  fs.renameSync(checkpointPath+'.tmp',checkpointPath);
  const lines=[input.headers.map(csv).join(',')];
  for(const row of input.records) {
    const r=state.results[row.row];
    lines.push([row.id,row.phone,row.email,r?.current??'', '',r?.transactions??'',r?.comment??''].map(csv).join(','));
  }
  const out=path.join(ROOT,'UGPASS-results.csv');
  fs.writeFileSync(out+'.tmp','\ufeff'+lines.join('\r\n'));
  fs.renameSync(out+'.tmp',out);
}
function phone(raw) {
  let d=String(raw??'').replace(/\D/g,'');
  if(/^0\d{9}$/.test(d))d='256'+d.slice(1);
  else if(/^\d{9}$/.test(d))d='256'+d;
  if(!/^256\d{9}$/.test(d))throw new Error('Invalid phone format');
  return '+'+d;
}
function controls(page) {
  return page.locator('#TransactionStatus').locator('xpath=ancestor::*[.//button[translate(normalize-space(.), "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")="APPLY"]][1]');
}
async function applyTransactions(page) {
  const button=controls(page).getByRole('button',{name:/^apply$/i}).filter({visible:true});
  if(await button.count()!==1)throw new Error('Cannot identify transaction Apply button');
  // Start observing the table before the click. Do not read a previous result.
  const changed=page.waitForResponse(response=>response.request().method()==='POST' || /transaction/i.test(response.url()),{timeout:15000}).catch(()=>null);
  await button.click();
  const response=await changed;
  if(response && response.status()>=400)throw new Error('Transaction request failed: '+response.status());
  const total=page.getByText(/Showing\s+\d+\s+to\s+\d+\s+of\s+[\d,]+/).filter({visible:true});
  await total.waitFor({state:'visible',timeout:30000});
  const match=(await total.innerText()).match(/\bof\s+([\d,]+)/i);
  if(!match)throw new Error('Cannot parse transaction count');
  return Number(match[1].replace(/,/g,''));
}
async function dates(page) {
  const field=page.getByRole('textbox',{name:'Select Date Range'});
  console.log('  Calendar: checking picker API');
  const result = await field.evaluate((element, range) => {
    const jq = window.jQuery;
    if (!jq) return {ok:false, detail:'jQuery unavailable'};
    const picker = jq(element).data('daterangepicker');
    if (!picker || typeof picker.setStartDate !== 'function' || typeof picker.setEndDate !== 'function') {
      return {ok:false, detail:'daterangepicker API unavailable; attached data keys: '+Object.keys(jq(element).data() || {}).join(', ')};
    }
    const dates = range.split(' - ').map(text => {
      const [day,month,year] = text.split('/').map(Number);
      return new Date(year,month-1,day,12);
    });
    picker.setStartDate(dates[0]);
    picker.setEndDate(dates[1]);
    // Commit through the plugin's Apply handler when exposed, so callbacks
    // receive the dates as well as the visible input.
    if(typeof picker.clickApply === 'function') picker.clickApply();
    else {
      if(typeof picker.hide === 'function') picker.hide();
      if(typeof picker.updateElement === 'function') picker.updateElement();
    }
    jq(element).trigger('change');
    return {ok:true, detail:'daterangepicker API used'};
  }, RANGE);
  console.log('  Calendar: '+result.detail);
  if(!result.ok)throw new Error('Cannot set picker dates automatically: '+result.detail);
  const actual = await field.inputValue();
  const parts = actual.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
  const normalized = parts
    ? `${parts[1].padStart(2,'0')}/${parts[2].padStart(2,'0')}/${parts[3]} - ${parts[4].padStart(2,'0')}/${parts[5].padStart(2,'0')}/${parts[6]}`
    : actual;
  if(normalized !== RANGE)throw new Error(`Calendar reset the entered date range: expected ${RANGE}; displayed ${actual}`);
  console.log('  Calendar: date range verified');
}
async function lookup(page,row) {
  // Reload a blank search form to prevent another subscriber's stale data being reused.
  await page.goto(URL);
  await page.locator('#IdentifierType').waitFor({state:'visible'});
 const hasEmail = /^(?=[\x00-\x7F]+$)[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/.test(String(row.email || '').trim());
  const query=hasEmail?String(row.email).trim():phone(row.phone);
  await page.locator('#IdentifierType').selectOption(hasEmail?'3':'4');
  await page.getByRole('textbox',{name:hasEmail?'Enter Email':/Enter Mobile Number/}).fill(query);
  await page.getByRole('button',{name:'Search',exact:true}).click();
  const block=page.getByText(/Subscriber Status\s*(?:CERT_EXPIRED|INACTIVE|ACTIVE|SUSPENDED|DEACTIVATED|DISABLED|CERT_REVOKED)\b/i).filter({visible:true}).first();
  const notFound=page.getByText('Subscriber not found',{exact:true}).filter({visible:true});
  await block.or(notFound).first().waitFor({state:'visible'});
  if(await notFound.isVisible()) {
    await page.getByRole('button',{name:'Dismiss',exact:true}).click();
    return {complete:true,current:'No',transactions:0,comment:'Subscriber not found',checkedAt:new Date().toISOString()};
  }
  const m=(await block.innerText()).match(/Subscriber Status\s*(CERT_EXPIRED|INACTIVE|ACTIVE|SUSPENDED|DEACTIVATED|DISABLED|CERT_REVOKED)\b/i);
  if(!m)throw new Error('Unknown subscriber status');
  const body=await page.locator('body').innerText();
  // Extract the labelled profile contact, rather than matching the search
  // input itself elsewhere on the page.
  const mobileMatch=body.match(/\bMobile(?:\s+(?:Number|No\.?))?\s*:?\s*(\+?\d[\d ()-]{6,}\d)/i);
  const profilePhone=mobileMatch ? mobileMatch[1].trim() : '';
  const emailMatch=body.match(/\bEmail(?:\s+(?:Address|ID))?\s*:?\s*([^\s]+@[^\s]+)/i);
  const profileEmail=emailMatch ? emailMatch[1].trim() : '';
  const normalizedPhone=value=>{try{return phone(value);}catch{return String(value||'').replace(/\D/g,'');}};
  const contactMatches=hasEmail
    ? profileEmail.toLowerCase()===query.toLowerCase()
    : Boolean(profilePhone)&&normalizedPhone(profilePhone)===normalizedPhone(query);
  const contactNote=contactMatches ? ''
    : `CONTACT MISMATCH / REVIEW: Excel phone: ${row.phone || '(blank)'}; profile phone: ${profilePhone || '(not displayed/readable)'}. Search ${hasEmail?'email':'phone'}: ${query}; profile email: ${profileEmail || '(not displayed/readable)'}. Transaction count belongs to the returned profile. `;
  if(!contactMatches)console.log('  Contact mismatch: collecting returned profile transactions and noting both contacts.');
  // Account existence is determined by a verified profile, regardless of status.
  const current='Yes';
  await page.locator('#TransactionStatus').selectOption('BOTH');
  const type=page.locator('select').filter({has:page.locator('option').filter({hasText:/^All$/})});
  if(await type.count()!==1)throw new Error('Cannot identify transaction type');
  await type.selectOption({label:'All'});
  await dates(page);
  console.log('  Transactions: clicking filter Apply and reading total');
  const transactions=await applyTransactions(page);
  return {complete:true,current,transactions,comment:`${contactNote}Subscriber Status: ${m[1].toUpperCase()}. Transactions ${RANGE}; All/Both.`,checkedAt:new Date().toISOString()};
}
(async()=>{
  let browser;
  try {
    console.log('UGPass automation: default trial is 5 records. VPN must be connected.');
    console.log('Output: UGPASS-results.csv (Excel-compatible). Original workbook is not overwritten.');
    const username=(await rl.question('UGPass username: ')).trim();
    let password=await secret('UGPass password (hidden): ');
    browser=await chromium.launch({headless:false});
    const page=await browser.newPage();page.setDefaultTimeout(30000);
    await page.goto(URL);
    const accept=page.getByRole('button',{name:'Accept',exact:true});
    if(await accept.isVisible())await accept.click();
    await page.locator('#username').fill(username);
    await page.getByRole('button',{name:'Next',exact:true}).click();
    await page.locator('#password').fill(password);
    password='';
    await page.getByRole('button',{name:'Submit',exact:true}).click();
    await page.getByRole('link',{name:/Registration Authority/}).click();
    await page.getByRole('link',{name:'Subscriber',exact:true}).click();
    await page.locator('#IdentifierType').waitFor({state:'visible'});
    let processed=0,failures=0;
    save();
    for(const row of input.records) {
      if(state.results[row.row]?.complete)continue;
      if(processed>=LIMIT)break;
      console.log(`Checking Excel row ${row.row}, Study ID ${row.id}...`);
      try {
        state.results[row.row]=await lookup(page,row);
        failures=0;
        console.log(`  ${state.results[row.row].current}; transactions ${state.results[row.row].transactions}`);
      } catch(error) {
        failures++;
        state.results[row.row]={complete:false,comment:'REVIEW: '+error.message.split('\n')[0],checkedAt:new Date().toISOString()};
        console.error('  '+state.results[row.row].comment);
        console.error(error.message);
      }
      processed++;save();
      if(failures>=2)throw new Error('Two consecutive failed records. Stopped for review; progress saved.');
      await page.waitForTimeout(1000);
    }
    console.log('Trial/run finished. Open UGPASS-results.csv in Excel and compare the checked rows manually.');
    console.log('Re-running skips completed records and retries unresolved ones.');
  } catch(error) {
    console.error('Stopped:',error.message.split('\n')[0]);process.exitCode=1;
  } finally {
    await rl.question('Press Enter to close the browser: ');
    if(browser)await browser.close();rl.close();
  }
})();
