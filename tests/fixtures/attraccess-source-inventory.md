# Archived Attraccess inventory

`attraccess-original-source-inventory.json` was recovered on 2026-09-30 from the actual Git blobs of upstream commit `afa58e8a5eadfb340f317e6ec3227af0cf9b6c54`, tree `b1dd957b63d9afab16d3c1b395d7fc28ffb066fb`. The official GitHub commit endpoint confirmed that exact commit/tree before a depth-one fetch into private bare scratch. Each blob's Git SHA1 was checked while deriving its file mode and SHA256.

All 3,468 entries reproduce the existing canonical inventory SHA256 `12e8f5e46b91eaf4949d097b51b1582302a12796287fbd7316e933fd7cb699c5`. Applying only the already approved CommunityLicenseButton postimage hash reproduces the frozen fixture inventory SHA256 `2d141ba9af869253fbf2099a16934dbbd8029c83244f7205da6276d275d7bb6d`. The regression asserts both pins before running its unchanged drift cases.

This data makes inventory regression checks portable. Live archived environment qualification still requires the original full checkout and approved two-commit fixture history; runtime `sourceInventory()` continues checking those resources and every blob.
