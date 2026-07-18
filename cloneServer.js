const { ChannelType, PermissionsBitField } = require("discord.js");

// ── Clone a server's categories/channels (+ permission overwrites) ────────────
// Copies from sourceGuild into targetGuild. The bot must already be a member of
// both guilds with Manage Channels + Manage Roles in the target.
//
// Role overwrites are mapped by ROLE NAME (Discord role IDs are per-guild, so
// the source guild's role IDs mean nothing in the target). If a role with a
// matching name doesn't exist yet in the target, it's created (color + basic
// permissions copied, but NOT hoist/mentionable/position — cosmetic details
// you can fix up after). @everyone is always mapped to the target's own
// @everyone. Member-specific (non-role) overwrites are skipped and logged,
// since a specific user ID from server A usually isn't meaningful in server B.
async function cloneServerStructure(client, sourceGuildId, targetGuildId, opts = {}) {
  const { wipeTarget = false } = opts;

  const sourceGuild = await client.guilds.fetch(sourceGuildId).catch(() => null);
  const targetGuild = await client.guilds.fetch(targetGuildId).catch(() => null);
  if (!sourceGuild) return { success: false, reason: "Bot isn't in the source server (or bad ID)." };
  if (!targetGuild) return { success: false, reason: "Bot isn't in the target server (or bad ID)." };

  const me = await targetGuild.members.fetchMe();
  if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels) || !me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return { success: false, reason: "Bot needs Manage Channels + Manage Roles in the target server." };
  }

  const log = { rolesCreated: [], channelsCreated: [], categoriesCreated: [], skippedOverwrites: [], errors: [] };

  // Optional: wipe every existing channel in target first (dangerous — off by default)
  if (wipeTarget) {
    const existing = await targetGuild.channels.fetch();
    for (const [, ch] of existing) {
      if (!ch) continue;
      await ch.delete().catch(e => log.errors.push(`delete #${ch.name}: ${e.message}`));
    }
  }

  // ── 1. Build role name -> target role ID map ────────────────────────────────
  await sourceGuild.roles.fetch();
  await targetGuild.roles.fetch();
  const roleMap = new Map(); // sourceRoleId -> targetRoleId
  roleMap.set(sourceGuild.roles.everyone.id, targetGuild.roles.everyone.id);

  const sourceRoles = [...sourceGuild.roles.cache.values()]
    .filter(r => r.id !== sourceGuild.roles.everyone.id && !r.managed)
    .sort((a, b) => a.position - b.position); // create in ascending order

  for (const role of sourceRoles) {
    let target = targetGuild.roles.cache.find(r => r.name === role.name);
    if (!target) {
      try {
        target = await targetGuild.roles.create({
          name: role.name,
          color: role.color,
          permissions: role.permissions,
          hoist: role.hoist,
          mentionable: role.mentionable,
        });
        log.rolesCreated.push(role.name);
      } catch (e) {
        log.errors.push(`role ${role.name}: ${e.message}`);
        continue;
      }
    }
    roleMap.set(role.id, target.id);
  }

  // ── 2. Map source overwrites -> target overwrites, dropping unmappable ones ─
  function mapOverwrites(sourceChannel) {
    const result = [];
    for (const ow of sourceChannel.permissionOverwrites.cache.values()) {
      if (ow.type === 0) { // role overwrite
        const mapped = roleMap.get(ow.id);
        if (mapped) {
          result.push({ id: mapped, allow: ow.allow.bitfield, deny: ow.deny.bitfield });
        } else {
          log.skippedOverwrites.push(`${sourceChannel.name}: unmapped role ${ow.id}`);
        }
      } else {
        // member-specific overwrite — skip, log for visibility
        log.skippedOverwrites.push(`${sourceChannel.name}: member overwrite ${ow.id} (not copied)`);
      }
    }
    return result;
  }

  // ── 3. Create categories first (sorted by position) ─────────────────────────
  const sourceChannels = [...sourceGuild.channels.cache.values()].sort((a, b) => a.rawPosition - b.rawPosition);
  const categories = sourceChannels.filter(c => c.type === ChannelType.GuildCategory);
  const categoryMap = new Map(); // sourceCategoryId -> targetCategoryId

  for (const cat of categories) {
    try {
      const created = await targetGuild.channels.create({
        name: cat.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: mapOverwrites(cat),
      });
      categoryMap.set(cat.id, created.id);
      log.categoriesCreated.push(cat.name);
    } catch (e) {
      log.errors.push(`category ${cat.name}: ${e.message}`);
    }
  }

  // ── 4. Create every non-category channel, attached to its mapped parent ─────
  const rest = sourceChannels.filter(c => c.type !== ChannelType.GuildCategory);
  for (const ch of rest) {
    try {
      const base = {
        name: ch.name,
        type: ch.type,
        parent: ch.parentId ? categoryMap.get(ch.parentId) || null : null,
        permissionOverwrites: mapOverwrites(ch),
      };
      if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
        base.topic = ch.topic || undefined;
        base.nsfw = ch.nsfw || false;
        base.rateLimitPerUser = ch.rateLimitPerUser || 0;
      }
      if (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) {
        base.bitrate = ch.bitrate || undefined;
        base.userLimit = ch.userLimit || undefined;
      }
      await targetGuild.channels.create(base);
      log.channelsCreated.push(ch.name);
    } catch (e) {
      log.errors.push(`channel ${ch.name}: ${e.message}`);
    }
  }

  return { success: true, log };
}

module.exports = { cloneServerStructure };
