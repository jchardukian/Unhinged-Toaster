import type { Config } from '../config.js';
import { chatJson } from '../llm.js';
import { log } from '../config.js';

/**
 * Realistic dog physical-comedy premises. Each is a beat sheet (hook within 2 s, escalation, visual payoff) that the
 * prompt builder turns into a single-shot, phone-footage-style generation prompt. Constraints keep the output
 * believable: one real-looking dog, natural light, handheld framing, no text, no humans' faces, no transformations.
 */
export interface Premise { id: string; title: string; hook: string; escalation: string; payoff: string; breed?: string; setting: string; seconds: number }

export const DOG_PREMISES: Premise[] = [
  { id: 'stick_door', title: 'The oversized stick', hook: 'a golden retriever proudly trots toward an open back door carrying a stick far wider than the doorway', escalation: 'the stick clunks against both door frames, the dog backs up, tilts its head and tries again', payoff: 'on the third try it turns sideways and squeezes through, tail wagging', breed: 'golden retriever', setting: 'suburban back yard, sunny afternoon', seconds: 12 },
  { id: 'pillow_landing', title: 'Confident couch jump', hook: 'a beagle sprints across a living room and leaps toward a couch', escalation: 'it overshoots and sails over the armrest', payoff: 'it lands in a heap of cushions on the floor, sits up with a pillow on its head', breed: 'beagle', setting: 'bright living room', seconds: 10 },
  { id: 'blanket_burrito', title: 'Blanket thief', hook: 'a French bulldog drags a fluffy blanket off a bed by one corner', escalation: 'the blanket wraps around it as it spins to get free', payoff: 'it ends up rolled like a burrito, only its face showing, blinking at the camera', breed: 'French bulldog', setting: 'bedroom with morning light', seconds: 12 },
  { id: 'workout_copy', title: 'Workout buddy', hook: 'a person in workout clothes does push-ups on a yoga mat while a border collie watches', escalation: 'the dog lies down beside them and lifts and lowers its front legs in time', payoff: 'the person stops, the dog keeps going and looks over as if to say keep up', breed: 'border collie', setting: 'home living room, daylight', seconds: 12 },
  { id: 'mirror_rival', title: 'Mirror rival', hook: 'a dachshund spots its reflection in a floor mirror and freezes', escalation: 'it play-bows, barks once, circles the mirror to catch the other dog', payoff: 'it checks behind the mirror, finds nothing and lies down facing it, suspicious', breed: 'dachshund', setting: 'hallway, soft daylight', seconds: 11 },
  { id: 'sprinkler', title: 'Sprinkler ambush', hook: 'a labrador stalks a lawn sprinkler head', escalation: 'the sprinkler rotates and sprays it straight in the face', payoff: 'it leaps backwards, shakes, then charges back in to bite the water', breed: 'labrador', setting: 'sunny lawn', seconds: 10 },
  { id: 'ball_math', title: 'Too many balls', hook: 'a corgi stands over three tennis balls and tries to pick up two at once', escalation: 'every time it grabs one, another rolls away', payoff: 'it lies down on top of all three with a satisfied sigh', breed: 'corgi', setting: 'park grass', seconds: 11 },
  { id: 'stairs_drama', title: 'Stair strategy', hook: 'a basset hound stares down a short flight of stairs', escalation: 'it places one paw, retreats, whines, tries again', payoff: 'it finally slides down on its belly like a toboggan and trots off', breed: 'basset hound', setting: 'carpeted home staircase', seconds: 12 },
  { id: 'robot_vacuum', title: 'The vacuum rides', hook: 'a small terrier barks at a robot vacuum crossing the kitchen', escalation: 'the vacuum bumps a chair and reverses toward the dog', payoff: 'the dog hops onto the vacuum and rides it across the floor, startled but staying on', breed: 'Jack Russell terrier', setting: 'kitchen, daylight', seconds: 12 },
  { id: 'sneeze_fall', title: 'The sneeze', hook: 'a pug sits proudly on a low garden wall', escalation: 'it sniffs a flower and builds up to a huge sneeze', payoff: 'the sneeze knocks it sideways into a soft flower bed; it pops back up, dusted with petals', breed: 'pug', setting: 'garden, afternoon light', seconds: 10 },
  { id: 'treat_fakeout', title: 'Fake throw', hook: 'a person pretends to throw a ball and a husky bolts across the yard', escalation: 'the husky searches, digs, looks under a bush', payoff: 'it returns, sees the ball still in the hand, and sits down with an offended stare', breed: 'husky', setting: 'back yard', seconds: 12 },
  { id: 'door_wait', title: 'Wrong door', hook: 'a spaniel waits at a closed glass door, nose pressed to it', escalation: 'the door next to it is wide open the whole time', payoff: 'it finally notices, looks at the camera, and walks through the open door', breed: 'cocker spaniel', setting: 'patio doors, daylight', seconds: 11 },
  { id: 'bath_escape', title: 'Bath time', hook: 'a shaggy sheepdog hears the bath taps running and tiptoes backwards down the hallway', escalation: 'it tries to hide behind a thin floor lamp', payoff: 'it stays perfectly still behind the lamp, visible from head to tail, convinced it is hidden', breed: 'old English sheepdog', setting: 'home hallway', seconds: 11 },
  { id: 'cat_bed', title: 'Cat-sized bed', hook: 'a great dane walks up to a tiny cat bed', escalation: 'it circles it three times and tries to curl up', payoff: 'it ends up with only its head in the bed and the rest sprawled across the floor, content', breed: 'great dane', setting: 'living room', seconds: 12 },
  { id: 'leaf_pile', title: 'Leaf dive', hook: 'a puppy runs toward a big pile of autumn leaves', escalation: 'it disappears completely into the pile', payoff: 'the pile shuffles around, then the puppy erupts out of the top with leaves on its head', breed: 'golden retriever puppy', setting: 'autumn park', seconds: 10 },
  { id: 'snack_ninja', title: 'Counter surfer', hook: 'a dog slowly rises on hind legs behind a kitchen counter where a sandwich sits', escalation: 'its nose creeps toward the plate while it watches the doorway', payoff: 'a cupboard door swings open and bonks it on the head; it sits down innocently', breed: 'labrador', setting: 'kitchen', seconds: 12 },
  { id: 'frisbee_miss', title: 'Frisbee confidence', hook: 'a dog leaps high for a frisbee in slow motion-like grace', escalation: 'the frisbee sails just over its head', payoff: 'it lands, watches the frisbee hit the fence, and trots to it as if that was the plan', breed: 'Australian shepherd', setting: 'park', seconds: 10 },
  { id: 'puddle_jump', title: 'Puddle', hook: 'a small dog stops at a tiny puddle on a path', escalation: 'it winds up as if the puddle were a canyon', payoff: 'it jumps a huge distance and lands in a bigger puddle on the other side', breed: 'Yorkshire terrier', setting: 'rainy park path', seconds: 10 },
  { id: 'squeaky_fear', title: 'Squeaky toy', hook: 'a large dog squeezes a new squeaky toy and is startled by the squeak', escalation: 'it pokes the toy from a distance, it squeaks again', payoff: 'it sneaks up from behind and pounces, then runs off victorious with the toy', breed: 'rottweiler', setting: 'living room rug', seconds: 11 },
  { id: 'reflection_sun', title: 'Chasing the light', hook: 'a dog chases a sun reflection dancing on the floor', escalation: 'it corners it against the wall and pounces', payoff: 'the reflection reappears on its own back; it spins in circles trying to see it', breed: 'whippet', setting: 'sunlit room', seconds: 11 },
];

const REALISM = 'Realistic handheld smartphone video, natural daylight, real fur texture and real dog anatomy with four legs, natural weight and timing, single continuous shot, no slow motion, no text, no captions, no logos, no humans faces in frame, no cartoon or exaggerated physics, no transformation, vertical 9:16.';

export function buildPrompt(p: Premise): string {
  return `${p.hook}; ${p.escalation}; ${p.payoff}. Setting: ${p.setting}. ${p.breed ? `Breed: ${p.breed}. ` : ''}Comedy beat timing: the funny situation is visible in the first two seconds, the payoff happens in the last third. ${REALISM}`;
}

export const NEGATIVE = 'text, watermark, cartoon, extra legs, deformed paws, floating objects, morphing, human face, slow motion';

/** Optionally let the LLM vary a premise (fresh phrasing, same beats) and write the on-screen hook. Falls back to the template. */
export async function variantPrompt(cfg: Config, p: Premise, usedTitles: string[]): Promise<{ prompt: string; headline: string; commentary: string }> {
  try {
    const r = await chatJson<{ prompt?: string; headline?: string; commentary?: string }>(cfg,
      `You write single-shot video generation prompts for REALISTIC funny dog videos (phone footage look) and the on-screen copy. Keep the three beats (hook within 2 s, escalation, payoff last third), one dog, believable physics, no text in the video. Output JSON {"prompt": string (<= 90 words, ends with the realism constraints verbatim), "headline": string (<= 6 words, ALL CAPS), "commentary": string (one sentence the angry toaster mascot yells, <= 80 chars)}. Realism constraints to append verbatim: "${REALISM}"`,
      JSON.stringify({ premise: p, avoid_titles: usedTitles.slice(-10) }), { temperature: 0.8, maxTokens: 400 });
    if (r.prompt && r.prompt.length > 40 && r.headline && r.commentary) return { prompt: r.prompt.includes('vertical 9:16') ? r.prompt : `${r.prompt} ${REALISM}`, headline: r.headline.slice(0, 60), commentary: r.commentary.slice(0, 100) };
  } catch (e) { log.warn(`variantPrompt failed (${(e as Error).message.slice(0, 100)}); using the template`); }
  return { prompt: buildPrompt(p), headline: p.title.toUpperCase(), commentary: `This ${p.breed ?? 'dog'} has more confidence than sense and I respect it.` };
}
