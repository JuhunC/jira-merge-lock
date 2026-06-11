#!/usr/bin/env node
// Tiny fake Jira for the e2e recipe (plan §12). No dependencies.
//
//   MOCK_JIRA_PORT=8089 node tools/mock-jira.mjs
//
//   GET  /rest/api/2/issue/{KEY}?fields=status   -> issue status (PRJ-1 seeded as "In Progress")
//   POST /toggle/{KEY}                           -> flip key between "In Progress" and "Closed"
//   GET  /rest/api/2/myself                      -> auth probe
import http from 'node:http';

const PORT = Number(process.env.MOCK_JIRA_PORT ?? 8089);
const issues = new Map([['PRJ-1', 'In Progress']]);

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return status;
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const issueMatch = path.match(/^\/rest\/api\/2\/issue\/([^/]+)$/);
  const toggleMatch = path.match(/^\/toggle\/([^/]+)$/);
  let status;

  if (req.method === 'GET' && issueMatch) {
    const key = decodeURIComponent(issueMatch[1]);
    const name = issues.get(key);
    status =
      name === undefined
        ? json(res, 404, { errorMessages: ['Issue does not exist'] })
        : json(res, 200, {
            key,
            fields: {
              status: {
                name,
                statusCategory: { key: name === 'Closed' ? 'done' : 'indeterminate', name },
              },
            },
          });
  } else if (req.method === 'POST' && toggleMatch) {
    const key = decodeURIComponent(toggleMatch[1]);
    const next = issues.get(key) === 'Closed' ? 'In Progress' : 'Closed';
    issues.set(key, next);
    status = json(res, 200, { key, status: next });
  } else if (req.method === 'GET' && path === '/rest/api/2/myself') {
    status = json(res, 200, { name: 'mock' });
  } else {
    status = json(res, 404, { errorMessages: ['Not found'] });
  }

  console.log(`${req.method} ${req.url} -> ${status}`);
});

server.listen(PORT, () => {
  console.log(`mock-jira listening on http://localhost:${PORT} (PRJ-1 = ${issues.get('PRJ-1')})`);
});
