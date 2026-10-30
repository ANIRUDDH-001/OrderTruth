import { renderLab } from "./view.ts";
import type { LabPageData } from "../../../scripts/lab-build.ts";
declare const __ORDERTRUTH_LAB__: LabPageData;
try { renderLab(document, __ORDERTRUTH_LAB__); }
catch { const root = document.querySelector("#app"); if (root) root.textContent = "Integration Lab could not be displayed. No verification or payment operation was run."; }
