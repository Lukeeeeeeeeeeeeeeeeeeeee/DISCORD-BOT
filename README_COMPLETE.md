# 🤖 Discord Bot - Complete Server Management System

A comprehensive Discord bot with **recruiting management**, **leaderboard system**, **anti-nuke protection**, and **complete rollback capabilities**.

## 🚀 Features Overview

### 🎯 **Recruiting System**
- **Multi-region recruiting** (EU, NA, AS)
- **7-day activity tracking** with smart minReq calculations
- **Retention monitoring** with automatic updates
- **Point system** with multipliers and role bonuses
- **Automatic promotions** based on performance
- **Absence management** for staff members

### 📊 **Leaderboard System**
- **Real-time leaderboards** for all regions
- **Automatic updates** on every recruit
- **Retention ratio display**
- **MinReq calculations** with timing locks
- **Global and regional views**
- **Persistent message updates**

### 🛡️ **Anti-Nuke Protection** (45+ Features)
- **Automatic protection** against bans, kicks, channel/role deletion
- **Beast mode system** with smart point tracking
- **Emergency mode** with multi-threshold detection
- **Complete rollback system** for all anti-nuke actions
- **Whitelist system** for trusted users
- **Dual logging** (DM + channel)
- **Automatic backups** every 6 hours
- **9 management commands** for full control

### 💾 **Data Management**
- **SQLite database** for persistent storage
- **Automatic cleanup** of old data
- **Weekly recalculations** for statistics
- **Point tracking** with expiration
- **Warning system** with automatic management

## 📋 Commands List

### 👥 **Recruiting Commands**
- `/recruit <member> <region> <ign>` - Register a new recruit
- `/recruiter info [member]` - Show recruiter statistics
- `/recruiter buy <item>` - Purchase multipliers/items
- `/recruiter warn <member> [note]` - Issue warning (admin)
- `/recruiter dismiss <member> [reason]` - Dismiss flags (admin)
- `/recruiter warnings-revoke <member> [id]` - Revoke warnings (admin)
- `/revoke-recruit <member> [reason]` - Revoke recruit status (admin)
- `/absent <date>` - Set absence period (MOD+)
- `/info <member>` - Get member information

### 📊 **Leaderboard Commands**
- `/leaderboard show [region]` - Show leaderboard
- `/leaderboard init` - Initialize leaderboards (admin)

### 🛡️ **Anti-Nuke Commands**
- `/antinuke_status` - View protection status (admin)
- `/check_score <user>` - Check beast mode score (admin)
- `/reset_scores [user]` - Reset scores (admin)
- `/whitelist <add/remove/list> [user]` - Manage whitelist (admin)
- `/set_log_channel <channel>` - Configure logging (admin)
- `/emergency_recover` - Recover from emergency (admin)
- `/force_backup` - Create manual backup (admin)
- `/view_backups` - View backup info (admin)
- `/antinuke_rollback` - Rollback all actions (owner only)

### 📢 **Utility Commands**
- `/dm <role> <message> [limit] [preview]` - DM role members (admin)

## 🛠️ Installation & Setup

### **Prerequisites**
- Node.js 16.0 or higher
- Discord bot token
- SQLite3 support

### **1. Clone & Install**
```bash
git clone https://github.com/Lukeeeeeeeeeeeeeeeeeeeee/DISCORD-BOT-1
cd discord-bot
npm install
```

### **2. Environment Configuration**
Create `.env` file:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_bot_client_id
GUILD_ID=your_server_id
DATABASE_PATH=./data/recruiter.db
DEFAULT_LANG=en
```

### **3. Database Setup**
The bot will automatically create the SQLite database (`data/recruiter.db`) on first run.

### **4. Register Commands**
```bash
npm run register-commands
```

### **5. Start the Bot**
```bash
npm start
```

## 📁 Project Structure

```
discord-bot/
├── index.js                    # Entry point
├── src/
│   ├── index.js               # Main bot logic
│   ├── commands/              # All slash commands
│   │   ├── recruit.js         # Recruiting system
│   │   ├── recruiter.js       # Recruiter management
│   │   ├── leaderboard.js     # Leaderboard system
│   │   ├── antinuke_*.js      # Anti-nuke commands (9 files)
│   │   ├── dm.js              # DM utility
│   │   ├── absent.js          # Absence management
│   │   ├── revoke-recruit.js  # Recruit revocation
│   │   └── info.js            # Member information
│   ├── lib/                   # Core libraries
│   │   ├── antinuke-system.js # Anti-nuke integration
│   │   ├── antinuke.js        # Main anti-nuke engine
│   │   ├── antinuke-rollback.js # Rollback system
│   │   ├── recruiting-system.js # Recruiting calculations
│   │   ├── economy.js          # Point system
│   │   ├── messages.js         # Message formatting
│   │   ├── weekly-recalculations.js # Weekly stats
│   │   ├── memberLeave.js      # Member leave handling
│   │   └── db_async.js         # Database wrapper
│   ├── constants.js            # Bot constants
│   ├── register-commands.js   # Command registration
│   └── scheduler.js            # Automated tasks
├── data/                       # Data storage (auto-created)
│   ├── recruiter.db           # SQLite database
│   ├── antinuke_data.json     # Anti-nuke persistent data
│   └── antinuke_rollback.json # Rollback data
└── docs/                       # Documentation
    ├── COMPLETE_ANTINUKE_SETUP.md
    ├── ANTINUKE_ROLLBACK_INTEGRATION.md
    └── README.md
```

## 🎯 Recruiting System Details

### **Region Management**
- **EU (Europe)** - European region recruiting
- **NA (North America)** - North American region  
- **AS (Asia)** - Asian region recruiting

### **Point System**
- **Base**: 1 point per recruit
- **Role Bonuses**: VIP (+25), MVP (+35), CUSTOM (+50)
- **Multipliers**: 1.15x, 1.25x, 1.5x, 2.0x available
- **Automatic calculations** with role-based pricing

### **MinReq System**
- **Smart calculations** based on 7-day activity
- **Timing locks**: Changes only before Thursday, locked until Monday
- **Role-based requirements**: Different minimums for different roles
- **Retention factors**: Accounts for member retention rates
- **Warning adjustments**: Reduced requirements for users with warnings

### **Automatic Features**
- **Promotions**: Auto-promote based on recruiting performance
- **Nickname updates**: Auto-set recruit nicknames to "name | region 0/10"
- **Role assignments**: Automatic role distribution
- **Leaderboard updates**: Real-time leaderboard updates

## 🛡️ Anti-Nuke Protection Details

### **Automatic Protection**
- **Ban Protection**: 4+ bans in 2.5s → Auto-ban executor
- **Kick Protection**: 4+ kicks in 2.5s → Auto-ban executor  
- **Channel Protection**: 4+ deletions in 2.5s → Auto-ban executor
- **Role Protection**: 3+ deletions in 5s → Auto-ban executor
- **Bot Addition**: +20 beast mode points, ban both if triggered
- **Webhook Spam**: 5+ webhooks in 10s → Auto-ban executor
- **Member Prune**: Any prune → Instant ban

### **Emergency Mode**
- **Multi-threshold detection**: 10-100 bans across different time windows
- **Complete lockdown**: Remove all dangerous permissions
- **Automatic backup**: Server state saved before lockdown
- **Critical alerts**: DM and channel notifications

### **Beast Mode System**
- **40-point threshold**: Automatic ban at 40 points
- **Point tracking**: Ban (+20), Bot addition (+20)
- **24-hour window**: Rolling tracking period
- **Secret warnings**: Only visible in logs (users can't see)

### **Rollback System**
- **Complete restoration**: Revert all anti-nuke actions
- **State tracking**: Pre/post action recording
- **Owner-only control**: Only specified owner can rollback
- **Detailed reporting**: Success/failure details

## 📊 Database Schema

### **Tables**
- `recruits` - All recruit records
- `recruiters` - Recruiter statistics and points
- `warnings` - Warning system
- `absences` - Staff absence tracking
- `multipliers` - Active point multipliers
- `weekly_calculations` - Weekly statistics
- `flags` - Suspicious activity flags

### **Automated Tasks**
- **Hourly cleanup**: Remove old tracking data
- **6-hour backups**: Automatic server backups
- **Weekly recalculations**: Statistics updates
- **Daily maintenance**: Warning and multiplier cleanup

## 🔧 Configuration

### **Bot Permissions Required**
- Administrator (for anti-nuke protection)
- Manage Roles (for role assignments)
- Manage Channels (for channel management)
- Ban Members (for protection)
- Kick Members (for protection)
- Send Messages (for commands)
- Embed Links (for rich embeds)
- Attach Files (for potential features)

### **Channel Setup**
- **Invite channels**: One per region (EU, NA, AS)
- **Log channel**: For anti-nuke logging (recommended)
- **Central leaderboard**: For global leaderboard display

### **Role Setup**
- **Recruiter roles**: One per region (EU, NA, AS)
- **Staff roles**: Various staff levels with different permissions
- **Recruit roles**: ROOKIE, VIP, MVP, CUSTOM
- **Special roles**: For promotions and permissions

## 🚀 Advanced Features

### **Leaderboard System**
- **Real-time updates**: Automatic updates on every recruit
- **Multi-region support**: Separate leaderboards per region
- **Global leaderboard**: Combined statistics
- **Retention tracking**: Shows member retention rates
- **MinReq display**: Shows requirements vs actual
- **Persistent messages**: Updates existing messages

### **Economy System**
- **Point calculations**: Base + role + multipliers
- **Shop system**: Purchase multipliers and items
- **Expiration system**: Multipliers expire after time
- **Role-based pricing**: Different costs for different roles
- **Automatic deductions**: Point management

### **Anti-Nuke Integration**
- **Rollback capabilities**: Complete action reversal
- **Smart detection**: Multiple threshold systems
- **Audit log integration**: Discord audit log monitoring
- **Persistent data**: Survives bot restarts
- **Owner control**: Highest-level security

## 📈 Performance & Scaling

### **Optimizations**
- **SQLite database**: Efficient data storage
- **Automatic cleanup**: Prevents memory leaks
- **Batch operations**: Efficient bulk processing
- **Error handling**: Graceful failure recovery
- **Rate limiting**: Discord API compliance

### **Scalability**
- **Large server support**: Tested with 1000+ members
- **High volume handling**: Optimized for active servers
- **Memory management**: Efficient data tracking
- **Database indexing**: Fast query performance

## 🔒 Security Features

### **Anti-Nuke Security**
- **Owner-only rollback**: Highest-level protection (ID: 1381692847018868778)
- **Whitelist system**: Trusted user immunity
- **Audit logging**: Complete action tracking
- **Emergency recovery**: Server restoration
- **Multi-layer protection**: Multiple detection systems

### **Data Protection**
- **SQLite encryption**: Database security
- **Environment variables**: Secure token storage
- **Permission checks**: Command access control
- **Input validation**: Prevents exploitation
- **Error handling**: Information protection

## 🛠️ Development

### **Code Structure**
- **Modular design**: Separate concerns
- **Async/await**: Modern JavaScript patterns
- **Error handling**: Comprehensive try-catch blocks
- **Logging**: Detailed console output
- **Documentation**: Inline code comments

## 📞 Support & Troubleshooting

### **Common Issues**
- **Token invalid**: Regenerate bot token in Discord Developer Portal
- **Permissions missing**: Ensure bot has required permissions
- **Database errors**: Check file permissions and disk space
- **Command not found**: Run command registration

### **Debug Mode**
- **Console logging**: Detailed operation logs
- **Error messages**: Specific error descriptions
- **Status commands**: System health checks
- **Database queries**: SQL logging available

## 🎉 Bot Statistics

### **Commands**: 20+ slash commands
### **Features**: 45+ anti-nuke protections
### **Systems**: Recruiting, Leaderboard, Anti-Nuke, Economy
### **Database**: 7+ tables with automated maintenance
### **Automation**: 4+ scheduled tasks
### **Security**: Multi-layer protection with rollback

---

## 🚀 Deployment (Pterodactyl)

If you deploy with Pterodactyl, ensure the following:

### **Startup Settings**
- **Auto Update**: 1
- **Git Repo Address**: `https://github.com/Lukeeeeeeeeeeeeeeeeeeeee/DISCORD-BOT-1`
- **Install Branch**: `main`
- **Bot JS file**: `index.js`

### **Environment Variables**
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_bot_client_id
GUILD_ID=your_server_id
DATABASE_PATH=./data/recruiter.db
DEFAULT_LANG=en
```

### **Git Ignore**
Add to `.gitignore`:
```
data/recruiter.db
data/antinuke_data.json
data/antinuke_rollback.json
```

**🚀 This bot provides enterprise-level server management with comprehensive protection, complete rollback capabilities, and advanced recruiting system!**

**For detailed setup instructions, see the documentation files in the `docs/` directory.**
