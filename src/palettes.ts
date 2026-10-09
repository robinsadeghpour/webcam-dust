export type Rgb = [number, number, number];

export interface Palette {
  name: string;
  /** Grains in shadow. */
  deep: Rgb;
  /** The body of the dust. */
  body: Rgb;
  /** Highlights and sparkles. */
  pale: Rgb;
  /** What a falling grain cools to before it disappears. */
  ember: Rgb;
  /** Tint that dense dust is pulled towards so it never burns out to white. */
  core: Rgb;
  /** Background at the centre and at the corners. */
  roomCentre: Rgb;
  roomEdge: Rgb;
  /** Colour of the soft glow the figure throws into the room. */
  haze: Rgb;
  exposure: number;
  /** The one colour the plain tracking overlay uses besides white, as CSS. */
  accent: string;
}

/** "#rrggbb" in sRGB to linear light. */
function hex(code: string): Rgb {
  const n = parseInt(code.slice(1), 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [channel((n >> 16) & 255), channel((n >> 8) & 255), channel(n & 255)];
}

export const palettes: Palette[] = [
  {
    name: 'Gold',
    deep: hex('#b0500c'),
    body: hex('#f3a52f'),
    pale: hex('#ffe7b4'),
    ember: hex('#96300a'),
    core: hex('#ff9a1f'),
    roomCentre: hex('#120b06'),
    roomEdge: hex('#040302'),
    haze: hex('#c26a1c'),
    exposure: 1.0,
    accent: '#ffb732',
  },
  {
    name: 'Pearl',
    deep: hex('#77706c'),
    body: hex('#d8d0c6'),
    pale: hex('#ffffff'),
    ember: hex('#5a5560'),
    core: hex('#e9dfd2'),
    roomCentre: hex('#131314'),
    roomEdge: hex('#050506'),
    haze: hex('#8f8a86'),
    exposure: 0.9,
    accent: '#d9cfc0',
  },
  {
    name: 'Rose gold',
    deep: hex('#9c3f3c'),
    body: hex('#ee9a80'),
    pale: hex('#ffe9de'),
    ember: hex('#7a2030'),
    core: hex('#ff8d6e'),
    roomCentre: hex('#120908'),
    roomEdge: hex('#040202'),
    haze: hex('#b8564a'),
    exposure: 1.0,
    accent: '#ff9c82',
  },
  {
    name: 'Glacier',
    deep: hex('#13508f'),
    body: hex('#58bdea'),
    pale: hex('#ecfbff'),
    ember: hex('#1b2f7a'),
    core: hex('#3fa9ff'),
    roomCentre: hex('#050a11'),
    roomEdge: hex('#010204'),
    haze: hex('#2b78c4'),
    exposure: 1.05,
    accent: '#63c8ff',
  },
];
