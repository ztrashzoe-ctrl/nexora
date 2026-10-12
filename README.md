# Nexora — shared Discord server directory

This is a real backend-backed version of Nexora. It does not include demo servers, fake counts, AI features, or localStorage listings. Listings are stored in PostgreSQL and shared by all visitors.

## Included
- Discord OAuth sign-in (`identify` scope)
- Shared PostgreSQL listings
- Add, edit, and delete only your own listings
- Individual `/s/:slug` server pages with server-rendered title/description/Open Graph/Twitter metadata
- Join links and report submissions stored for review
- One bump per listing every 24 hours
- Search, category filters, sorting, and 12-item pagination
- Responsive classic light directory styling

## Important before launch
- This needs a Node.js host and a PostgreSQL database. Opening `index.html` directly in Acode will not run the backend.
- Reports are stored in the database, but this starter does not include a moderator/admin dashboard or automatic moderation. Someone with database access must review reports.
- Invite links are format-checked, not verified against Discord. Server names and descriptions are user-submitted.
- Add your own privacy policy and terms before inviting the public.

## Environment variables
Copy `.env.example` to `.env` for local development, then fill in real values. Never share or commit `.env`.
- `DATABASE_URL`: PostgreSQL connection URL
- `SESSION_SECRET`: random secret of 32+ characters
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`: from Discord Developer Portal → OAuth2
- `DISCORD_REDIRECT_URI`: exact callback URL registered in Discord
- `APP_URL`: public base URL, with no trailing slash
- `NODE_ENV=production` when deployed

## Local run (requires Node.js and npm)
1. `npm install`
2. Create `.env` based on `.env.example` and fill in credentials.
3. `npm start`
4. Open `http://localhost:3000`.

## Hosting outline
1. Create a managed PostgreSQL database with a provider that gives you a connection URL.
2. Create a Node web service from this folder on a Node-compatible host.
3. Set the environment variables above in the host's environment settings. Set `APP_URL` to the deployed HTTPS URL and set `DISCORD_REDIRECT_URI` to `APP_URL/auth/discord/callback`.
4. In Discord Developer Portal → your application → OAuth2, add that exact callback URL to Redirects. Use the client ID and client secret from the same application.
5. Deploy/redeploy. On startup, Nexora creates its required database tables.
6. Test Discord login, add a listing, and visit it from another browser/device to verify the shared database.

Do not use an ephemeral SQLite file or localStorage for the public directory: PostgreSQL is the shared persistent database for this project.
