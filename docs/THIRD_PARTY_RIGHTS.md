# Third-party rights verification

## Current inspection — October 21, 2026

The owners authorized the root MIT license and package metadata. This license applies to original OrderTruth contributions; it does not relicense dependencies or provider brands/services.

- VERIFIED: tracked frontend assets contain HTML, TypeScript, CSS and inline SVG. No bundled photographs, music, video, external font files or icon package were found in the tracked-file inventory.
- VERIFIED: after adding the PostgreSQL driver, the installed production dependency license inventory reports MIT (68 packages), BSD-3-Clause (3), ISC (6), and BlueOak-1.0.0 (5), using `pnpm licenses list --prod --json`. Counts include transitive packages and are a point-in-time inventory, not a substitute for their license texts.
- NOT_TESTED: provenance of the existing inline SVG symbols and logo in `web/console/index.html`. Their simple geometry alone does not establish originality. Confirm their source or replace them with documented original or licensed drawings before public release.
- RECORDED_NOT_REPRODUCED: the owners confirmed rights to license original code jointly. This inspection cannot independently establish authorship of every prior contribution.
- NOT_TESTED: final shipped dependency notices and bundled third-party license texts. Recheck the final dependency graph and retain required notices with distributed artifacts.
- NOT_TESTED: current PayPal SDK/brand usage compliance. The SDK is remotely loaded, not owned by OrderTruth; retain approved SDK buttons and independent OrderTruth branding. Verify the actual script URL, usage terms and connectivity labels before release.
- NOT_TESTED: GitHub license detection. The standard root `LICENSE` and SPDX package value `MIT` are now present locally. Confirm GitHub's reported SPDX identifier after an authorized publication; no publication is implied by this file.

No unclear asset has been declared original or relicensed by assumption.
