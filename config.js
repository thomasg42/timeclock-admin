// JustUs Entertainment TimeClock — backend endpoint.
//
// Thomas's call on 2026-08-25: stay on n8n for now and pay for the higher
// execution allowance, rather than cut over to the Cloudflare Worker tonight.
// So this stays pointed at n8n.
//
// The worker in ./worker/ is built, tested (37 tests) and ready. Switching to
// it is this one line plus the deploy steps in worker/README.md. It costs
// nothing to run and does not share an execution quota with the other FGA
// businesses — worth revisiting the next time this quota runs out.
//   window.TC_API = 'https://justus-timeclock.forevergoldai.workers.dev';
window.TC_API = 'https://tggai.app.n8n.cloud/webhook';
