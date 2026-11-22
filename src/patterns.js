// Each step is [strength, milliseconds]. Strength runs from 0 to 1 and is
// multiplied by the live intensity after overlapping patterns are mixed.

const wave = [
  [0.25, 110],
  [0.5, 110],
  [0.75, 110],
  [1, 160],
  [0, 130],
];

export const PATTERNS = {
  like: {
    label: 'Like',
    name: 'soft double tap',
    steps: [
      [0.45, 110],
      [0, 90],
      [0.7, 170],
    ],
  },
  retweet: {
    label: 'Retweet',
    name: 'two rising waves',
    steps: [...wave, ...wave],
  },
  reply: {
    label: 'Reply',
    name: 'long, short, short',
    steps: [
      [1, 520],
      [0, 150],
      [0.7, 130],
      [0, 120],
      [0.7, 130],
    ],
  },
};
