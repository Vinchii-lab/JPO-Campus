const fs = require('fs');
let code = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

const inviteHtml = `
        <br><br>
        <input id="home-invite-email" type="email" placeholder="coworker@email.com">
        <button data-invite>Invite</button>
        \${homeState.invitations && homeState.invitations.length ? '<div style="margin-top:8px"><small>Active Invitations:</small>' + homeState.invitations.map(i => '<span class="home-item">' + esc(i.name) + ' <button data-revoke="' + esc(i.invitee_email) + '">Revoke</button></span>').join('') + '</div>' : ''}
`;

code = code.replace(/<input id="home-invite-email"[^>]+>\s*<button data-invite>Invite<\/button>/, inviteHtml);

const bindHtml = `
    homePanel.querySelector('[data-invite]')?.addEventListener('click', () => socket.emit('homeInvite', { email:homePanel.querySelector('#home-invite-email').value }));
    homePanel.querySelectorAll('[data-revoke]').forEach(b => b.onclick = () => socket.emit('homeInvite', { email:b.dataset.revoke, revoke:true }));
`;

code = code.replace(/homePanel\.querySelector\('\\[data-invite\\]'\)\?\.addEventListener\('click', \(\) => socket\.emit\('homeInvite', \{ email:homePanel\.querySelector\('#home-invite-email'\)\.value \}\)\);/, bindHtml);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', code);
