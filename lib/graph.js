export function packUsers(users) {
  const list = Array.isArray(users) ? users : users ? [users] : [];
  return list
    .map((user) => ({
      id: String(user?.id ?? "").trim(),
      screenName: user?.screenName || "",
      name: user?.name || "",
      avatar: user?.avatar || "",
    }))
    .filter((user) => user.id);
}

export function withDerived(result) {
  if (!result) return null;
  const notBack = result.notBack || [];
  const mutual = result.mutual || [];
  const fansOnly = result.fansOnly || [];
  return {
    ...result,
    notBack,
    mutual,
    fansOnly,
    following: result.following || [...mutual, ...notBack],
    followers: result.followers || [...mutual, ...fansOnly],
    counts: {
      following: (result.following || [...mutual, ...notBack]).length,
      followers: (result.followers || [...mutual, ...fansOnly]).length,
      notBack: notBack.length,
      mutual: mutual.length,
      fansOnly: fansOnly.length,
      followingOfficial: result.counts?.followingOfficial || result.me?.followingCount,
      followersOfficial: result.counts?.followersOfficial || result.me?.followersCount,
      unavailableFollowers: result.counts?.unavailableFollowers || 0,
    },
  };
}

export function persistable(result) {
  const full = withDerived(result);
  return {
    me: full.me,
    scannedAt: full.scannedAt,
    notBack: full.notBack,
    mutual: full.mutual,
    fansOnly: full.fansOnly,
    modes: full.modes,
    counts: full.counts,
  };
}

export function applyUnfollowed(result, unfollowed) {
  const gone = new Set(unfollowed.map((u) => u.id));
  const keep = (arr) => (arr || []).filter((u) => !gone.has(u.id));
  const moved = (result.mutual || []).filter((u) => gone.has(u.id));
  return withDerived({
    ...result,
    notBack: keep(result.notBack),
    mutual: keep(result.mutual),
    fansOnly: [...keep(result.fansOnly), ...moved],
    following: keep(result.following),
    followers: result.followers,
  });
}

export function applyFollowed(result, followed) {
  const ids = new Set(followed.map((u) => u.id));
  const keep = (arr) => (arr || []).filter((u) => !ids.has(u.id));
  const moved = (result.fansOnly || []).filter((u) => ids.has(u.id));
  const extra = followed.filter((u) => !moved.some((m) => m.id === u.id));
  return withDerived({
    ...result,
    fansOnly: keep(result.fansOnly),
    mutual: [...(result.mutual || []), ...moved, ...extra],
    following: [...(result.following || []), ...followed],
    notBack: result.notBack,
    followers: result.followers,
  });
}
