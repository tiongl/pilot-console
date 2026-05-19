const { execSync } = require('child_process');
const fs = require('fs');

const NEW_EMAIL = 'tiongl@users.noreply.github.com';
const NEW_NAME = 'Tiong Lee';

// Get all commits on main in chronological order
const log = execSync('git --no-pager log main --reverse --format=%H|||%aI|||%s', { encoding: 'utf8' });
const commits = log.trim().split('\n').map(line => {
  const [hash, date, ...msgParts] = line.split('|||');
  return { hash, date, msg: msgParts.join('|||') };
}).filter(c => c.hash);

console.log(`Total commits: ${commits.length}`);

// Generate weekend days (Sat+Sun) from Mar 28 to May 17, 2026
const weekends = [];
let d = new Date(2026, 2, 28); // Mar 28 (Sat)
const end = new Date(2026, 4, 17);
while (d <= end) {
  if (d.getDay() === 6) { // Saturday
    weekends.push(new Date(d));
    const sun = new Date(d);
    sun.setDate(sun.getDate() + 1);
    weekends.push(sun);
  }
  d.setDate(d.getDate() + 1);
}
console.log(`Weekend days available: ${weekends.length}`);

// Distribute commits across weekend days
const perDay = Math.ceil(commits.length / weekends.length);
let dayIdx = 0, countOnDay = 0;

const dateMap = {};
const msgMap = {};

for (let i = 0; i < commits.length; i++) {
  const c = commits[i];
  const wd = weekends[dayIdx];
  
  // Spread commits within day (9am-11pm)
  const hourFrac = 9 + (countOnDay / Math.max(perDay, 1)) * 14;
  const h = Math.floor(hourFrac);
  const m = Math.floor((hourFrac - h) * 60);
  const s = (i * 17) % 60;
  
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${wd.getFullYear()}-${pad(wd.getMonth()+1)}-${pad(wd.getDate())}T${pad(h)}:${pad(m)}:${pad(s)}-07:00`;
  dateMap[c.hash] = dateStr;
  
  // Fix copilot mentions
  let msg = c.msg;
  msg = msg.replace(/Copilot CLI /gi, 'CLI ');
  msg = msg.replace(/copilot\s+/gi, '');
  msg = msg.replace(/copilot/gi, '');
  msg = msg.replace(/  +/g, ' ').trim();
  
  if (msg !== c.msg) {
    console.log(`  MSG: "${c.msg}" -> "${msg}"`);
  }
  msgMap[c.hash] = msg;
  
  countOnDay++;
  if (countOnDay >= perDay) {
    countOnDay = 0;
    dayIdx++;
    if (dayIdx >= weekends.length) dayIdx = weekends.length - 1;
  }
}

// Build env-filter script for git filter-branch
let envScript = '';
for (const [hash, date] of Object.entries(dateMap)) {
  envScript += `if [ "$GIT_COMMIT" = "${hash}" ]; then\n`;
  envScript += `  export GIT_AUTHOR_DATE="${date}"\n`;
  envScript += `  export GIT_COMMITTER_DATE="${date}"\n`;
  envScript += `fi\n`;
}
envScript += `export GIT_AUTHOR_EMAIL="${NEW_EMAIL}"\n`;
envScript += `export GIT_COMMITTER_EMAIL="${NEW_EMAIL}"\n`;
envScript += `export GIT_AUTHOR_NAME="${NEW_NAME}"\n`;
envScript += `export GIT_COMMITTER_NAME="${NEW_NAME}"\n`;

fs.writeFileSync('env-filter.sh', envScript, { encoding: 'utf8' });

// Build msg-filter script
let msgScript = '#!/bin/bash\nread -r -d "" MSG || true\n';
for (const c of commits) {
  if (msgMap[c.hash] !== c.msg) {
    const escaped = msgMap[c.hash].replace(/"/g, '\\"');
    msgScript += `if [ "$GIT_COMMIT" = "${c.hash}" ]; then echo "${escaped}"; exit 0; fi\n`;
  }
}
msgScript += 'echo "$MSG"\n';

fs.writeFileSync('msg-filter.sh', msgScript, { encoding: 'utf8' });

console.log(`\nGenerated env-filter.sh and msg-filter.sh`);
console.log(`Commits spread across ${dayIdx + 1} weekend days`);
console.log(`\nSample mappings:`);
const samples = [...commits.slice(0, 3), ...commits.slice(-3)];
for (const c of samples) {
  console.log(`  ${c.hash.slice(0,8)} ${c.date.slice(0,10)} -> ${dateMap[c.hash].slice(0,10)}  ${msgMap[c.hash].slice(0,50)}`);
}
