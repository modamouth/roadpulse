// Sequential red scale, light -> dark, one hue — matches the approach used
// in docs/prototype-dashboard.html. See that file's history / the dataviz
// guidance it followed: sequential encoding for magnitude, never a rainbow.
const SEV_STEPS = ['#3a2020', '#6b2b2b', '#a3342f', '#d0432f', '#e66767'];

export function severityColor(t: number): string {
  const idx = Math.min(SEV_STEPS.length - 1, Math.floor(t * SEV_STEPS.length));
  return SEV_STEPS[idx];
}
