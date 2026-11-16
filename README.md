# JPO Huddle / JPO HQ

## Project inventory for JPO

Reviewed on **November 16, 2026**, against the current workspace source and published-app metadata. This entry covers **this project only**, not a complete list of software its developer may be working on.

| Requested detail | Current summary |
| --- | --- |
| **Project** | **JPO Huddle**, branded **JPO HQ**. A browser-based multiplayer virtual office for the JustPressOne team, with avatars, team chat, announcements, games, and optional proximity voice. It works in desktop and mobile browsers. |
| **Relationship to JPO** | Built for JPO team engagement and internal communication. |
| **Time per week** | **Approximately 1–2 hours per week**, spent on updates and maintenance. Estimate supplied by the developer. |
| **Overall goal** | Help staff connect across departments and participate in shared activities in a virtual office, using announcements, social interactions, games, and in-game rewards. |
| **Stage** | Published, with ongoing development. A published app exists; this does not establish that every feature in the workspace has been released. |
| **Where it lives** | Developed in **Replit** and published through a **Replit VM deployment** at **https://jpo-hq.com**. Additional published address: https://jpo-campus.replit.app. Durable application data uses PostgreSQL. Exact database infrastructure, region, and administrative ownership were not verified in this review. |
| **Who can access it** | The website and registration page are publicly reachable. The standard game-entry flow uses an individual email/password account and administrator approval; returning approved users can also use a saved, signed session token. Intended users are JPO staff, but the code does not verify ownership of a JPO email address or use company SSO. |
| **Administrative access** | Separate shared admin and owner passwords unlock different privileges, with authorization enforced on the server. These are shared role credentials, not individual administrator accounts. Discreet mobile access still requires the same authorization; a hidden entry is not itself a security control. |
| **Company, client, or employee data** | **Yes: employee-identifiable and company-related data.** This includes staff names, email addresses, departments, account/approval information, messages and shared images, announcements, activity records, and game progress. The app is not designed as a client-record system, but client or confidential information could be entered into free-text messages or images. Production contents were not inspected, so absence of client data cannot be asserted. |

## Security and privacy detail

### Controls identified in the current code

- Individual account passwords are stored as salted **scrypt hashes**, not plaintext.
- The normal login flow checks credentials and approval status. Login attempts are rate-limited.
- Remembered sessions use signed tokens with a 30-day maximum age, stored in browser local or session storage according to the user's choice.
- Privileged actions check server-side admin/owner authorization. The owner tier has additional powers unavailable to ordinary admins.
- Database connection details and privileged service credentials are supplied through the runtime environment rather than exposed as client-side configuration.
- The published address uses HTTPS. Its deployment visibility is **public**; application approval is separate from making the entire website private.

### Data handling that must be disclosed

- **Private messages are stored.** The server records delivered private-message text and images, including sender/recipient identifiers, and permits owner-authorized review. They should not be described as visible only to the participants or as end-to-end encrypted private messaging.
- The private-message log has an approximate row-count pruning mechanism around the latest 5,000 records, checked periodically on writes. This is **not a defined time-based retention/deletion policy**.
- Employee-linked information also includes game activity, progress, preferences, coaching intake/activities, and administrative activity logs.
- Optional AI features use an OpenAI-compatible service through Replit AI Integrations. Depending on the feature, requests can include player/coworker names and departments for connection coaching, and typed workplace-policy quiz answers for grading. **The app should not be described as keeping all employee information inside its own database.**
- Proximity voice uses browser WebRTC. The server is configured to obtain Twilio STUN/TURN connectivity credentials, with a STUN-only fallback when relay provisioning fails. This review does not attest to the current operational status of that integration.

### Limitations and items for company review

- No company SSO, MFA, or email-ownership verification was identified in the current application login flow.
- Legacy accounts without a password can set one through the registration flow. That account-claim process needs review before presenting the app as strongly verified employee identity.
- Shared admin/owner passwords, access revocation, privacy notices, message retention, and the company-approved scope of AI processing should be reviewed with JPO.
- This is a **source-based inventory**, not a penetration test, security certification, or compliance statement. Database-at-rest protections, backups, data residency, provider contractual terms, and actual production data were not audited.

## Scope and supporting references

- `replit.md` — project instructions and detailed technical working notes.
- `artifacts/jpo-huddle/server.js` — account login, approval and privileged-action checks; persistence; messaging and AI processing.
- `artifacts/jpo-huddle/public/index.html` — browser interface and remembered-session behavior.
- `artifacts/jpo-huddle/public/mobile-admin-access.js` — discreet mobile entry into the existing authorization flow.
- `lib/db/src/schema/jpoPlayers.ts` and `lib/db/src/schema/jpoCoach.ts` — employee-linked profile and coaching data definitions. The server also creates additional tables directly.

Other projects, such as Conativ, QA tools, or an LMS, require their own entries; their existence, status, hosting, weekly time, and security have not been inferred from this workspace.
