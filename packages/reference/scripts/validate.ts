/** CLI: validate the reference library and print a buildability summary per capability. */
import { buildabilityOf, coverageMatrix, listCapabilities, referenceArtifacts, validateLibrary } from '../src';

const issues = validateLibrary();
for (const i of issues) console.log(`${i.severity.toUpperCase().padEnd(7)} ${i.path}: ${i.message}`);
const errors = issues.filter((i) => i.severity === 'error').length;

const arts = referenceArtifacts();
console.log(`\nreference artifacts: ${arts.length} (${arts.filter((a) => a.verification.status === 'verified').length} verified)`);
console.log(`coverage entries: ${coverageMatrix().entries.length}`);
for (const cap of listCapabilities()) {
  const counts: Record<string, number> = {};
  for (const el of cap.design.elements) {
    const s = buildabilityOf(el).status;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const origins: Record<string, number> = {};
  for (const el of cap.design.elements) origins[el.origin] = (origins[el.origin] ?? 0) + 1;
  console.log(`\n${cap.id} v${cap.version}: ${cap.outcomes.length} outcomes, ${cap.design.elements.length} design elements`);
  console.log(`  origin:       ${JSON.stringify(origins)}`);
  console.log(`  buildability: ${JSON.stringify(counts)}`);
}
console.log(errors ? `\n${errors} error(s)` : '\nlibrary valid');
process.exit(errors ? 1 : 0);
