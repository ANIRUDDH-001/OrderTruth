# Third-party rights verification

## Current inspection — October 21, 2026

The owners authorized the root MIT license and package metadata. This license applies to original OrderTruth contributions; it does not relicense dependencies or provider brands/services.

- VERIFIED: tracked frontend assets contain HTML, TypeScript, CSS and inline SVG. No bundled photographs, music, video, external font files or icon package were found in the tracked-file inventory.
- VERIFIED: after adding PostgreSQL and maintained authentication, the installed production dependency license inventory reports MIT (121 packages), Apache-2.0 (2), BSD-3-Clause (4), ISC (7), BlueOak-1.0.0 (5), and MPL-2.0 (2), using `pnpm licenses list --prod --json`. Counts include transitive packages and are a point-in-time inventory, not a substitute for their license texts. Dependency licenses remain their own; the root MIT license does not replace their notice or source requirements.
- NOT_TESTED: provenance of the existing inline SVG symbols and logo in `web/console/index.html`. Their simple geometry alone does not establish originality. Confirm their source or replace them with documented original or licensed drawings before public release.
- RECORDED_NOT_REPRODUCED: the owners confirmed rights to license original code jointly. This inspection cannot independently establish authorship of every prior contribution.
- NOT_TESTED: final shipped dependency notices and bundled third-party license texts. Recheck the final dependency graph and retain required notices with distributed artifacts.
- NOT_TESTED: current PayPal SDK/brand usage compliance. The SDK is remotely loaded, not owned by OrderTruth; retain approved SDK buttons and independent OrderTruth branding. Verify the actual script URL, usage terms and connectivity labels before release.
- VERIFIED: GitHub license detection returned HTTP200 and SPDX MIT for the public repository after the authorized push on October21,2026. The root LICENSE contains the jointly confirmed copyright notice.

No unclear asset has been declared original or relicensed by assumption.
