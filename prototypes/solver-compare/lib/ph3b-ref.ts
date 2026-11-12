/** Reference hashes for the PH-3b bench and tests (issue #146). */
/** sha256 of every agent's motion record (samples) at 83397c5, the commit before the contact-kind split (issue #146):
 *  the split adds read-only bookkeeping, so the trajectories must stay bit-identical. 83397c5 was itself checked
 *  bit-identical to 6864974 (tests/ph3b-contact-time.test.ts history). */
export const TRAJ_SHA256_83397C5: Record<string, string> = {
  'head-on-2': '18a2c31e8629945b48931a9cf57b9b59a84462a5208d31c3d42a1fdc3114c274',
  'corridor-8': 'b093f2d0525d92f7443d37325c926f85b4ab0cedc855737ab73f0e6db77b8bcf',
  stone: '339131b618d1e547ba28cf8ee9026b2cf3c214e8ca097a7572b9c6bded6c828b',
  crossing: 'ee15e3672c29d1d4ead7d5f336efd3d400c50723e90a3bce69a0dff8d216b1c0',
  'crossing-traffic-100': 'c6d70773a7ed0e1c8ceceb2fc8bd78d6a74628cf6627bb48f829fab753adefb0',
  'crossing-traffic-1000': 'd5f18bfca5ab902178795ba12aab822938116a5c8d5d93aa94c1b1d561c09d9b',
};
