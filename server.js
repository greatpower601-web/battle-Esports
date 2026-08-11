require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const fs = require("fs");
const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const dataDir = path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, "battle-esports.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('deposit','entry_fee','prize','refund','withdrawal')),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','rejected')),
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('Battle Royal','Clash Squad')),
  entry_fee INTEGER NOT NULL DEFAULT 0,
  prize_pool INTEGER NOT NULL DEFAULT 0,
  max_players INTEGER NOT NULL DEFAULT 50,
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','live','completed','cancelled')),
  room_id TEXT,
  room_password TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tournament_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tournament_id, user_id),
  FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

function seed() {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@battleesports.local";
  const adminPassword = process.env.ADMIN_PASSWORD || "ChangeThisAdminPassword123!";
  const existing = db.prepare("SELECT id FROM users WHERE email=?").get(adminEmail);
  if (!existing) {
    const hash = bcrypt.hashSync(adminPassword, 12);
    const info = db.prepare("INSERT INTO users(username,email,password_hash,role) VALUES(?,?,?,'admin')")
      .run("admin", adminEmail, hash);
    db.prepare("INSERT INTO wallets(user_id,balance) VALUES(?,0)").run(info.lastInsertRowid);
  }
  const count = db.prepare("SELECT COUNT(*) c FROM tournaments").get().c;
  if (!count) {
    const insert = db.prepare(`INSERT INTO tournaments
      (title,mode,entry_fee,prize_pool,max_players,starts_at,status)
      VALUES(?,?,?,?,?,?,?)`);
    insert.run("Daily Battle Royal", "Battle Royal", 25, 1000, 50, new Date(Date.now()+86400000).toISOString(), "upcoming");
    insert.run("Night Clash Squad", "Clash Squad", 50, 2000, 24, new Date(Date.now()+2*86400000).toISOString(), "upcoming");
  }
}
seed();

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({error:"Authentication required"});
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({error:"Invalid or expired token"});
  }
}
function admin(req,res,next){
  if(req.user.role !== "admin") return res.status(403).json({error:"Admin access required"});
  next();
}
function sign(user){ return jwt.sign({id:user.id,username:user.username,email:user.email,role:user.role}, JWT_SECRET, {expiresIn:"7d"}); }

app.post("/api/auth/register", (req,res)=>{
  const {username,email,password} = req.body || {};
  if(!username || !email || !password || password.length < 8) return res.status(400).json({error:"Username, email and an 8+ character password are required"});
  try {
    const hash = bcrypt.hashSync(password,12);
    const info = db.prepare("INSERT INTO users(username,email,password_hash) VALUES(?,?,?)").run(username.trim(),email.trim().toLowerCase(),hash);
    db.prepare("INSERT INTO wallets(user_id,balance) VALUES(?,0)").run(info.lastInsertRowid);
    const user = db.prepare("SELECT id,username,email,role FROM users WHERE id=?").get(info.lastInsertRowid);
    res.json({token:sign(user),user});
  } catch(e) {
    res.status(409).json({error:"Username or email already exists"});
  }
});

app.post("/api/auth/login",(req,res)=>{
  const {email,password}=req.body||{};
  const user=db.prepare("SELECT * FROM users WHERE email=?").get(String(email||"").trim().toLowerCase());
  if(!user || !bcrypt.compareSync(password||"",user.password_hash)) return res.status(401).json({error:"Invalid email or password"});
  res.json({token:sign(user),user:{id:user.id,username:user.username,email:user.email,role:user.role}});
});

app.get("/api/me",auth,(req,res)=>{
  const user=db.prepare("SELECT id,username,email,role,created_at FROM users WHERE id=?").get(req.user.id);
  const wallet=db.prepare("SELECT balance FROM wallets WHERE user_id=?").get(req.user.id);
  const stats=db.prepare(`SELECT COUNT(*) matches FROM tournament_entries WHERE user_id=?`).get(req.user.id);
  res.json({user,wallet,stats});
});

app.get("/api/tournaments",(req,res)=>{
  const rows=db.prepare(`SELECT t.*, COUNT(e.id) joined
    FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id=t.id
    GROUP BY t.id ORDER BY t.starts_at ASC`).all();
  res.json(rows);
});

app.post("/api/tournaments/:id/join",auth,(req,res)=>{
  const t=db.prepare("SELECT * FROM tournaments WHERE id=?").get(req.params.id);
  if(!t) return res.status(404).json({error:"Tournament not found"});
  if(t.status !== "upcoming") return res.status(400).json({error:"Tournament is not open"});
  const joined=db.prepare("SELECT COUNT(*) c FROM tournament_entries WHERE tournament_id=?").get(t.id).c;
  if(joined >= t.max_players) return res.status(400).json({error:"Tournament is full"});
  try {
    const tx=db.transaction(()=>{
      const wallet=db.prepare("SELECT balance FROM wallets WHERE user_id=?").get(req.user.id);
      if(wallet.balance < t.entry_fee) throw new Error("INSUFFICIENT");
      db.prepare("UPDATE wallets SET balance=balance-? WHERE user_id=?").run(t.entry_fee,req.user.id);
      db.prepare("INSERT INTO tournament_entries(tournament_id,user_id) VALUES(?,?)").run(t.id,req.user.id);
      db.prepare("INSERT INTO wallet_transactions(user_id,type,amount,status,reference) VALUES(?,?,?,?,?)")
        .run(req.user.id,"entry_fee",-t.entry_fee,"completed",`tournament:${t.id}`);
    });
    tx();
    res.json({ok:true,message:"Tournament joined"});
  } catch(e) {
    res.status(400).json({error:e.message==="INSUFFICIENT"?"Insufficient wallet balance":"Already joined or could not join"});
  }
});

/* Payment gateway webhook placeholder:
   A real provider must verify its webhook signature before crediting a wallet.
   Never credit a wallet from a client-side UPI/QR success screen. */
app.post("/api/payments/webhook",(req,res)=>{
  res.status(501).json({error:"Payment webhook not configured. Connect a verified payment provider before enabling deposits."});
});

app.get("/api/wallet",auth,(req,res)=>{
  const wallet=db.prepare("SELECT balance FROM wallets WHERE user_id=?").get(req.user.id);
  const tx=db.prepare("SELECT * FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 50").all(req.user.id);
  res.json({wallet,transactions:tx});
});

app.post("/api/withdrawals",auth,(req,res)=>{
  const {amount,method,destination}=req.body||{};
  const value=Number(amount);
  if(!Number.isInteger(value)||value<=0||!method||!destination) return res.status(400).json({error:"Valid amount, method and destination required"});
  try{
    const tx=db.transaction(()=>{
      const wallet=db.prepare("SELECT balance FROM wallets WHERE user_id=?").get(req.user.id);
      if(wallet.balance<value) throw new Error("INSUFFICIENT");
      db.prepare("UPDATE wallets SET balance=balance-? WHERE user_id=?").run(value,req.user.id);
      const info=db.prepare("INSERT INTO withdrawals(user_id,amount,method,destination) VALUES(?,?,?,?)").run(req.user.id,value,method,destination);
      db.prepare("INSERT INTO wallet_transactions(user_id,type,amount,status,reference) VALUES(?,?,?,?,?)")
        .run(req.user.id,"withdrawal",-value,"pending",`withdrawal:${info.lastInsertRowid}`);
    });
    tx(); res.json({ok:true,message:"Withdrawal request submitted"});
  }catch(e){res.status(400).json({error:e.message==="INSUFFICIENT"?"Insufficient balance":"Could not create withdrawal"});}
});

app.get("/api/withdrawals",auth,(req,res)=>{
  res.json(db.prepare("SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC").all(req.user.id));
});

/* Admin */
app.get("/api/admin/stats",auth,admin,(req,res)=>{
  res.json({
    users:db.prepare("SELECT COUNT(*) c FROM users WHERE role='user'").get().c,
    tournaments:db.prepare("SELECT COUNT(*) c FROM tournaments").get().c,
    pendingWithdrawals:db.prepare("SELECT COUNT(*) c FROM withdrawals WHERE status='pending'").get().c,
    walletLiability:db.prepare("SELECT COALESCE(SUM(balance),0) c FROM wallets").get().c
  });
});
app.get("/api/admin/users",auth,admin,(req,res)=>{
  res.json(db.prepare("SELECT id,username,email,role,created_at FROM users ORDER BY id DESC").all());
});
app.post("/api/admin/tournaments",auth,admin,(req,res)=>{
  const {title,mode,entry_fee,prize_pool,max_players,starts_at}=req.body||{};
  if(!title||!["Battle Royal","Clash Squad"].includes(mode)||Number(entry_fee)<0||Number(prize_pool)<0||!Number(max_players)||!starts_at)
    return res.status(400).json({error:"Invalid tournament data"});
  const info=db.prepare(`INSERT INTO tournaments(title,mode,entry_fee,prize_pool,max_players,starts_at)
    VALUES(?,?,?,?,?,?)`).run(title,mode,Number(entry_fee),Number(prize_pool),Number(max_players),starts_at);
  res.json(db.prepare("SELECT * FROM tournaments WHERE id=?").get(info.lastInsertRowid));
});
app.patch("/api/admin/tournaments/:id",auth,admin,(req,res)=>{
  const allowed=["title","mode","entry_fee","prize_pool","max_players","starts_at","status","room_id","room_password"];
  const keys=Object.keys(req.body||{}).filter(k=>allowed.includes(k));
  if(!keys.length) return res.status(400).json({error:"No editable fields supplied"});
  const vals=keys.map(k=>req.body[k]);
  const set=keys.map(k=>`${k}=?`).join(",");
  db.prepare(`UPDATE tournaments SET ${set} WHERE id=?`).run(...vals,req.params.id);
  res.json(db.prepare("SELECT * FROM tournaments WHERE id=?").get(req.params.id));
});
app.delete("/api/admin/tournaments/:id",auth,admin,(req,res)=>{
  db.prepare("DELETE FROM tournaments WHERE id=?").run(req.params.id);
  res.json({ok:true});
});
app.get("/api/admin/withdrawals",auth,admin,(req,res)=>{
  res.json(db.prepare(`SELECT w.*,u.username,u.email FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC`).all());
});
app.patch("/api/admin/withdrawals/:id",auth,admin,(req,res)=>{
  const {status}=req.body||{};
  if(!["approved","rejected","paid"].includes(status)) return res.status(400).json({error:"Invalid status"});
  const w=db.prepare("SELECT * FROM withdrawals WHERE id=?").get(req.params.id);
  if(!w) return res.status(404).json({error:"Withdrawal not found"});
  if(w.status==="pending" && status==="rejected"){
    const tx=db.transaction(()=>{
      db.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?").run(w.id);
      db.prepare("UPDATE wallets SET balance=balance+? WHERE user_id=?").run(w.amount,w.user_id);
      db.prepare("INSERT INTO wallet_transactions(user_id,type,amount,status,reference) VALUES(?,?,?,?,?)")
        .run(w.user_id,"refund",w.amount,"completed",`withdrawal:${w.id}`);
    });
    tx();
  } else {
    db.prepare("UPDATE withdrawals SET status=? WHERE id=?").run(status,w.id);
  }
  res.json({ok:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Battle Esports running on http://localhost:${PORT}`));
