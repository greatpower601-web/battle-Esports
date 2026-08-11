# Battle Esports — Connected Tournament App

## What is connected
- User registration/login with bcrypt password hashing
- JWT authentication
- User profile
- Battle Royal + Clash Squad tournaments
- Tournament join + entry-fee ledger
- SQLite wallet and transaction history
- Withdrawal request flow
- Admin dashboard
- Admin tournament create/edit/delete API
- Admin withdrawal approve/reject API
- Seeded admin account

## Run locally
1. Install Node.js 18+.
2. Copy `.env.example` to `.env` and change `JWT_SECRET` and admin password.
3. Run:
   `npm install`
   `npm start`
4. Open `http://localhost:3000`.

## Default admin
The values come from `.env`:
- Email: `admin@battleesports.local`
- Password: `ChangeThisAdminPassword123!`

Change them before using the app.

## Important payment note
The deposit webhook endpoint intentionally returns 501 until a real payment provider is configured and its webhook signature is verified. Do not credit wallet balance from a client-side "payment successful" screen or a UPI intent callback.

For production, add:
- HTTPS
- secure cookie/session or short-lived access tokens + refresh tokens
- rate limiting
- CSRF protection where applicable
- provider webhook signature verification
- KYC/age/jurisdiction checks as legally required
- audit logs
- database backups
- server-side tournament result verification
- fraud/abuse controls
- proper payout-provider integration

This starter does not claim that a payment was completed or that a withdrawal was paid merely because a user clicked a button.
