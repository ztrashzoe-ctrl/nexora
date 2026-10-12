'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const crypto = require('crypto');

const required = ['DATABASE_URL', 'SESSION_SECRET', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'APP_URL'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) { console.error('Missing environment variables:', missing.join(', ')); process.exit(1); }
if (process.env.SESSION_SECRET.length < 32) { console.error('SESSION_SECRET must be at least 32 characters.'); process.exit(1); }
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } });
const APP_URL = process.env.APP_URL.replace(/\/$/, '');
const categories = ['Gaming','Community','Anime','Technology','Music','Education','Other'];
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  name: 'nexora.sid', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api', apiLimiter);

async function initDb() {
 await pool.query(`CREATE TABLE IF NOT EXISTS nexora_users (id TEXT PRIMARY KEY, username TEXT NOT NULL, avatar TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS nexora_servers (
 id BIGSERIAL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES nexora_users(id) ON DELETE CASCADE,
 name VARCHAR(80) NOT NULL, description VARCHAR(2000) NOT NULL, category VARCHAR(32) NOT NULL,
 invite_url TEXT NOT NULL, slug VARCHAR(120) UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), bumped_at TIMESTAMPTZ, last_bumped_at TIMESTAMPTZ
 );
 CREATE INDEX IF NOT EXISTS nexora_servers_bump_idx ON nexora_servers (bumped_at DESC NULLS LAST, created_at DESC);
 CREATE TABLE IF NOT EXISTS nexora_reports (id BIGSERIAL PRIMARY KEY, server_id BIGINT NOT NULL REFERENCES nexora_servers(id) ON DELETE CASCADE, reporter_id TEXT REFERENCES nexora_users(id) ON DELETE SET NULL, reason VARCHAR(40) NOT NULL, details VARCHAR(1000) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status VARCHAR(20) NOT NULL DEFAULT 'open');`);
}
function currentUser(req) { return req.session && req.session.user ? req.session.user : null; }
function auth(req,res,next) { if (!currentUser(req)) return res.status(401).json({ error: 'Sign in with Discord to do that.' }); next(); }
function cleanText(value, max) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max); }
function validInvite(value) { try { const u = new URL(value); return u.protocol === 'https:' && ['discord.gg','www.discord.gg','discord.com','www.discord.com'].includes(u.hostname) && (u.hostname.includes('discord.gg') ? u.pathname.length > 1 : u.pathname.startsWith('/invite/')); } catch { return false; } }
function slugify(s) { return s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80) || 'server'; }
async function uniqueSlug(name, excludeId) { const base = slugify(name); for (let i=0;i<8;i++) { const slug = i ? `${base}-${crypto.randomBytes(2).toString('hex')}` : base; const q = await pool.query('SELECT id FROM nexora_servers WHERE slug=$1 AND ($2::bigint IS NULL OR id<>$2)',[slug,excludeId || null]); if (!q.rowCount) return slug; } return `${base}-${crypto.randomBytes(5).toString('hex')}`; }
function publicServer(row) { return { id: String(row.id), name: row.name, description: row.description, category: row.category, inviteUrl: row.invite_url, slug: row.slug, ownerId: row.owner_id, ownerName: row.owner_name || null, createdAt: row.created_at, updatedAt: row.updated_at, bumpedAt: row.bumped_at, lastBumpedAt: row.last_bumped_at }; }
const selectServers = `SELECT s.*, u.username AS owner_name FROM nexora_servers s JOIN nexora_users u ON u.id=s.owner_id`;

app.get('/auth/discord', (req,res) => {
 const state = crypto.randomBytes(24).toString('hex'); req.session.oauthState = state;
 const q = new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, redirect_uri: process.env.DISCORD_REDIRECT_URI, response_type: 'code', scope: 'identify', state });
 res.redirect('https://discord.com/oauth2/authorize?' + q.toString());
});
app.get('/auth/discord/callback', async (req,res,next) => {
 try {
  if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send('Discord sign-in could not be verified. Please go back and try again.');
  delete req.session.oauthState;
  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code:String(req.query.code),redirect_uri:process.env.DISCORD_REDIRECT_URI}) });
  const token = await tokenResponse.json(); if (!tokenResponse.ok || !token.access_token) return res.status(400).send('Discord sign-in failed. Please try again.');
  const profileResponse = await fetch('https://discord.com/api/users/@me', { headers:{Authorization:`Bearer ${token.access_token}`} });
  const profile = await profileResponse.json(); if (!profileResponse.ok || !profile.id) return res.status(400).send('Could not read your Discord profile.');
  await pool.query(`INSERT INTO nexora_users(id,username,avatar) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username,avatar=EXCLUDED.avatar`,[profile.id,profile.global_name || profile.username,profile.avatar]);
  await new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));
  req.session.user = { id: profile.id, username: profile.global_name || profile.username, avatar: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=96` : null };
  req.session.save(err=>{ if(err) return next(err); res.redirect(APP_URL + '/'); });
 } catch(e) { next(e); }
});
app.post('/auth/logout', (req,res) => req.session.destroy(err=>{ if(err) return res.status(500).json({error:'Could not sign out.'}); res.clearCookie('nexora.sid'); res.json({ok:true}); }));
app.get('/api/me', (req,res)=>res.json({ user: currentUser(req) }));
app.get('/api/servers', async (req,res,next) => {
 try {
  const page = Math.max(1, Math.min(100000, parseInt(req.query.page,10)||1)); const limit = 12;
  const search = cleanText(req.query.q,100); const category = categories.includes(req.query.category) ? req.query.category : '';
  const sort = ['newest','oldest','name'].includes(req.query.sort) ? req.query.sort : 'newest';
  const where=[]; const params=[];
  if(search){ params.push(`%${search.replace(/[\\%_]/g,'\\$&')}%`); where.push(`(s.name ILIKE $${params.length} ESCAPE '\\' OR s.description ILIKE $${params.length} ESCAPE '\\')`); }
  if(category){params.push(category);where.push(`s.category=$${params.length}`);}
  const clause=where.length?' WHERE '+where.join(' AND '):'';
  const count=await pool.query(`SELECT COUNT(*)::int AS total FROM nexora_servers s${clause}`,params); const total=count.rows[0].total; const pages=Math.max(1,Math.ceil(total/limit)); const safePage=Math.min(page,pages);
  let order = sort==='oldest'?'s.created_at ASC':sort==='name'?'s.name ASC':'COALESCE(s.bumped_at,s.created_at) DESC, s.created_at DESC';
  const result=await pool.query(`${selectServers}${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${(safePage-1)*limit}`,params);
  res.json({servers:result.rows.map(publicServer),page:safePage,pages,total,limit});
 } catch(e){next(e);}
});
app.get('/api/servers/:slug', async(req,res,next)=>{try{const r=await pool.query(`${selectServers} WHERE s.slug=$1`,[req.params.slug]);if(!r.rowCount)return res.status(404).json({error:'Server not found.'});res.json({server:publicServer(r.rows[0])});}catch(e){next(e);}});
app.get('/api/my-servers',auth,async(req,res,next)=>{try{const r=await pool.query(`${selectServers} WHERE s.owner_id=$1 ORDER BY s.created_at DESC`,[currentUser(req).id]);res.json({servers:r.rows.map(publicServer)});}catch(e){next(e);}});
app.post('/api/servers',auth,async(req,res,next)=>{try{
 const name=cleanText(req.body.name,80),description=String(req.body.description||'').trim().slice(0,2000),category=cleanText(req.body.category,32),inviteUrl=String(req.body.inviteUrl||'').trim();
 if(name.length<2||description.length<10||!categories.includes(category)||!validInvite(inviteUrl))return res.status(400).json({error:'Enter a server name, a description of at least 10 characters, a category, and a valid Discord invite URL.'});
 const slug=await uniqueSlug(name);const r=await pool.query('INSERT INTO nexora_servers(owner_id,name,description,category,invite_url,slug) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[currentUser(req).id,name,description,category,inviteUrl,slug]);res.status(201).json({server:publicServer({...r.rows[0],owner_name:currentUser(req).username})});
 }catch(e){next(e);}});
app.put('/api/servers/:id',auth,async(req,res,next)=>{try{
 const id=String(req.params.id);if(!/^\d+$/.test(id))return res.status(400).json({error:'Invalid listing.'});
 const name=cleanText(req.body.name,80),description=String(req.body.description||'').trim().slice(0,2000),category=cleanText(req.body.category,32),inviteUrl=String(req.body.inviteUrl||'').trim();
 if(name.length<2||description.length<10||!categories.includes(category)||!validInvite(inviteUrl))return res.status(400).json({error:'Check the name, description, category, and Discord invite URL.'});
 const old=await pool.query('SELECT id FROM nexora_servers WHERE id=$1 AND owner_id=$2',[id,currentUser(req).id]);if(!old.rowCount)return res.status(404).json({error:'Listing not found or you do not own it.'});
 const slug=await uniqueSlug(name,id);const r=await pool.query('UPDATE nexora_servers SET name=$1,description=$2,category=$3,invite_url=$4,slug=$5,updated_at=NOW() WHERE id=$6 AND owner_id=$7 RETURNING *',[name,description,category,inviteUrl,slug,id,currentUser(req).id]);res.json({server:publicServer({...r.rows[0],owner_name:currentUser(req).username})});
 }catch(e){next(e);}});
app.delete('/api/servers/:id',auth,async(req,res,next)=>{try{const r=await pool.query('DELETE FROM nexora_servers WHERE id=$1 AND owner_id=$2',[req.params.id,currentUser(req).id]);if(!r.rowCount)return res.status(404).json({error:'Listing not found or you do not own it.'});res.json({ok:true});}catch(e){next(e);}});
app.post('/api/servers/:id/bump',auth,async(req,res,next)=>{try{
 const r=await pool.query('SELECT last_bumped_at FROM nexora_servers WHERE id=$1 AND owner_id=$2',[req.params.id,currentUser(req).id]);if(!r.rowCount)return res.status(404).json({error:'Listing not found or you do not own it.'});
 if(r.rows[0].last_bumped_at && Date.now()-new Date(r.rows[0].last_bumped_at).getTime()<24*60*60*1000){const remaining=24*60*60*1000-(Date.now()-new Date(r.rows[0].last_bumped_at).getTime());return res.status(429).json({error:`You can bump this listing again in about ${Math.ceil(remaining/3600000)} hour(s).`});}
 await pool.query('UPDATE nexora_servers SET bumped_at=NOW(),last_bumped_at=NOW() WHERE id=$1',[req.params.id]);res.json({ok:true});
 }catch(e){next(e);}});
app.post('/api/servers/:id/report',async(req,res,next)=>{try{
 const reasons=['invalid_invite','inappropriate','spam','other'];const reason=cleanText(req.body.reason,40),details=String(req.body.details||'').trim().slice(0,1000);if(!reasons.includes(reason))return res.status(400).json({error:'Choose a report reason.'});
 const exists=await pool.query('SELECT id FROM nexora_servers WHERE id=$1',[req.params.id]);if(!exists.rowCount)return res.status(404).json({error:'Listing not found.'});
 const reporter=currentUser(req);await pool.query('INSERT INTO nexora_reports(server_id,reporter_id,reason,details) VALUES($1,$2,$3,$4)',[req.params.id,reporter?reporter.id:null,reason,details]);res.status(201).json({ok:true,message:'Report submitted for review.'});
 }catch(e){next(e);}});

app.use(express.static('public', { extensions:['html'] }));
app.get('/s/:slug',async(req,res,next)=>{try{
 const r=await pool.query('SELECT name,description,category,slug FROM nexora_servers WHERE slug=$1',[req.params.slug]);if(!r.rowCount)return res.status(404).send('Server not found — Nexora');
 const s=r.rows[0];const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const title=`${s.name} — Discord Server | Nexora`;const desc=esc(s.description.slice(0,200));const canonical=`${APP_URL}/s/${encodeURIComponent(s.slug)}`;
 const fs = require('fs');
 const template = fs.readFileSync(require('path').join(process.cwd(),'public','index.html'),'utf8');
 const meta = `<title>${esc(title)}</title><meta name="description" content="${desc}"><link rel="canonical" href="${canonical}"><meta property="og:type" content="website"><meta property="og:site_name" content="Nexora"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${desc}"><meta property="og:url" content="${canonical}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${desc}"><script>window.NEXORA_DETAIL_SLUG=${JSON.stringify(s.slug)};</script>`;
 res.send(template.replace(/<title>[\s\S]*?<\/title>/i, meta));
 }catch(e){next(e);}});
app.get('*path',(req,res)=>res.sendFile(require('path').join(process.cwd(),'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'Something went wrong. Please try again.'});});
const port=process.env.PORT||3000;
initDb().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Nexora listening on ${port}`))).catch(err=>{console.error('Database initialization failed:',err);process.exit(1);});
