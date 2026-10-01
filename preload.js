function getNotificationRarityTier(value) {
  const percent = parseNotificationRarityPercent(value);
  if (percent === null) return "";
  if (percent > 50) return "bronze";
  if (percent > 20) return "silver";
  if (percent > 5) return "gold";
  if (percent >= 0) return "sapphire";
  return "";
}
