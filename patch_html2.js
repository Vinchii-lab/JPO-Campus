const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

const moreCss = `
#pb-waiting, #pb-incoming {
  position: fixed; z-index: 10000; bottom: 80px; left: 50%; transform: translateX(-50%);
  background: #1e1e30; border: 3px solid #5C4BE1; border-radius: 8px;
  padding: 12px 20px; font-family: 'Press Start 2P', monospace; font-size: 10px; color: #fff;
  display: none; align-items: center; gap: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.8);
}
#pb-waiting.open, #pb-incoming.open { display: flex; }
.pb-btn-sm {
  background: #3a3a5e; border: 2px solid #5C4BE1; color: #fff; font-family: inherit;
  font-size: 9px; padding: 6px 10px; border-radius: 4px; cursor: pointer;
}
.pb-btn-sm:hover { background: #5C4BE1; }
.pb-btn-sm-primary { background: #2ecc71; border-color: #27ae60; }
.pb-btn-sm-primary:hover { background: #27ae60; }
.pb-btn-sm-danger { background: #e74c3c; border-color: #c0392b; }
.pb-btn-sm-danger:hover { background: #c0392b; }
`;

html = html.replace('</style>', moreCss + '\n  </style>');

const moreHtml = `
  <div id="pb-waiting">
    <span id="pb-waiting-text">Challenging...</span>
    <button id="pb-waiting-cancel" class="pb-btn-sm pb-btn-sm-danger" type="button">Cancel</button>
  </div>
  <div id="pb-incoming">
    <span id="pb-incoming-text">Challenge from X!</span>
    <button id="pb-incoming-accept" class="pb-btn-sm pb-btn-sm-primary" type="button">Accept</button>
    <button id="pb-incoming-decline" class="pb-btn-sm pb-btn-sm-danger" type="button">Decline</button>
  </div>
`;

html = html.replace('<!-- ── Rock-Paper-Scissors challenges ── -->', moreHtml + '\n  <!-- ── Rock-Paper-Scissors challenges ── -->');

fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
