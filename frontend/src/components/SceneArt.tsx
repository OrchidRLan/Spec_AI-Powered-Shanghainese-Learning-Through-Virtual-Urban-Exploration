import { useId } from 'react'

type ArtProps = { label?: string; className?: string }
type LandmarkKind = 'restaurant' | 'candy' | 'nanxiang' | 'teahouse'
type ScenePose = 'welcome' | 'listening' | 'checking' | 'packed'

const palette = {
  ink: '#284c43', roof: '#315d50', roofLight: '#527969', roofDark: '#223e36',
  paper: '#f4eddd', plaster: '#ead9b9', wood: '#9a5b42', red: '#b86950',
  bamboo: '#cfaa6f', foliage: '#7c9676', foliageLight: '#a5b18a',
}

function ArtDefs({ id }: { id: string }) {
  return <defs>
    <linearGradient id={`${id}-roof`} x1="0" y1="0" x2="0" y2="1">
      <stop stopColor={palette.roofLight} /><stop offset="1" stopColor={palette.roofDark} />
    </linearGradient>
    <linearGradient id={`${id}-water`} x1="0" y1="0" x2="1" y2="1">
      <stop stopColor="#bad3bd" /><stop offset="1" stopColor="#84b5a1" />
    </linearGradient>
    <linearGradient id={`${id}-light`} x1="0" y1="0" x2="0" y2="1">
      <stop stopColor="#f9e8c3" /><stop offset="1" stopColor="#d8bd91" />
    </linearGradient>
    <linearGradient id={`${id}-counter`} x1="0" y1="0" x2="0" y2="1">
      <stop stopColor="#ac7650" /><stop offset="1" stopColor="#805239" />
    </linearGradient>
    <radialGradient id={`${id}-glow`}>
      <stop stopColor="#fff4ce" stopOpacity=".85" /><stop offset="1" stopColor="#fff4ce" stopOpacity="0" />
    </radialGradient>
    <pattern id={`${id}-tiles`} width="14" height="8" patternUnits="userSpaceOnUse">
      <path d="M0 8V3Q7-2 14 3V8" fill="none" stroke="#c0c9a9" strokeWidth=".7" opacity=".35" />
    </pattern>
    <pattern id={`${id}-lattice`} width="34" height="34" patternUnits="userSpaceOnUse">
      <path d="M0 0H34V34H0ZM8 0V26H34M0 8H26V34M8 8H26V26H8Z" fill="none" stroke="#7c503d" strokeWidth="2.4" />
    </pattern>
    <pattern id={`${id}-paper`} width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="3" cy="7" r=".65" fill="#8e795a" opacity=".1" />
      <circle cx="16" cy="20" r=".5" fill="#8e795a" opacity=".1" />
      <path d="M12 3h3M0 17h2" stroke="#fff" strokeWidth=".8" opacity=".3" />
    </pattern>
  </defs>
}

function Cloud({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`} fill="none" stroke="#d7d4be" strokeWidth="1.4" strokeLinecap="round">
    <path d="M-70 9h110c16 0 16-16 3-16-6 0-8 3-9 7M-26 9c-16 0-15-17-3-17 5 0 10 4 10 8" />
    <path d="M-86 16H4M20 16h51M-12-8c0-18 26-19 28-3 10-8 22-2 21 5" />
  </g>
}

function Tree({ x, y, scale = 1, variant = 0 }: { x: number; y: number; scale?: number; variant?: number }) {
  const light = variant % 2 ? '#a5ad7f' : '#95a982'
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <ellipse cy="5" rx="37" ry="11" fill="#566a4d" opacity=".1" />
    <path d="M0 5Q4-26-6-62M1-20l-21-19M-2-35l24-20" fill="none" stroke="#7d7454" strokeWidth="5" strokeLinecap="round" />
    <path d="M-34-33c-23-13-15-39 4-41-9-22 16-42 32-28 16-11 36 4 32 20 22 3 24 35 7 42 1 20-28 28-39 16-13 14-30 7-36-9Z" fill={light} />
    <path d="M-34-33c-19-14-11-35 0-38-1 19 17 33 33 25 14 9 30 0 34-15 16 11 11 28 1 30-5 17-23 18-35 7-12 12-27 7-33-9Z" fill="#688567" opacity=".65" />
    <path d="M-24-70c5-13 17-14 24-8M8-89c11-4 19 7 17 14M-15-47c7 6 15 5 21 0" fill="none" stroke="#c8d0a4" strokeWidth="2" opacity=".65" strokeLinecap="round" />
  </g>
}

function Pine({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <path d="M1 2Q-8-30 7-58Q12-80 3-100M-3-25l-33-30M5-58l30-19" fill="none" stroke="#79684b" strokeWidth="5" strokeLinecap="round" />
    <path d="M-52-51c1-13 10-14 15-13 2-13 18-17 26-6 12-6 22 3 24 12-16 7-48 11-65 7ZM-6-78c0-12 14-18 22-12 4-12 20-12 24-2 11-3 21 6 21 12-16 6-47 9-67 2ZM-24-100c3-10 15-13 22-9 6-15 26-12 26-1 11-1 18 5 17 11-16 7-49 8-65-1Z" fill="#506f59" />
    <path d="M-46-55l43-4M2-82l50-1M-16-103l49-1" stroke="#91a077" strokeWidth="2" strokeLinecap="round" />
  </g>
}

function Rocks({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`} stroke="#9a9d87" strokeWidth="1">
    <path d="m-31 6 5-22 13-8 15 10 8 20Z" fill="#c0c3a7" />
    <path d="m-11 6 9-42 15-10 13 18-3 12 13 22Z" fill="#afb59c" />
    <path d="m21 6 4-18 14-9L56 3Z" fill="#c8cbb2" />
    <path d="m-2-36 9 16-8 11m14-37-1 17 11 1m-36 4 5 15m33-3 10 8" fill="none" />
  </g>
}

function Roof({ id, y = 0, width = 222, height = 48 }: { id: string; y?: number; width?: number; height?: number }) {
  const w = width / 2
  const roofPath = `M${-w} ${y + 4}Q${-w + 24} ${y + 4} ${-w + 34} ${y - 11}L-24 ${y - height}Q0 ${y - height + 5} 24 ${y - height}L${w - 34} ${y - 11}Q${w - 24} ${y + 4} ${w} ${y + 4}L${w - 9} ${y + 13}Q0 ${y + 5} ${-w + 9} ${y + 13}Z`
  return <g>
    <path d={roofPath} fill={`url(#${id}-roof)`} stroke={palette.roofDark} strokeWidth="1.5" />
    <path d={roofPath} fill={`url(#${id}-tiles)`} />
    <path d={`M${-w - 4} ${y - 4}Q${-w + 7} ${y + 9} ${-w + 34} ${y - 11}L-24 ${y - height}Q0 ${y - height + 3} 24 ${y - height}L${w - 34} ${y - 11}Q${w - 7} ${y + 9} ${w + 4} ${y - 4}`} fill="none" stroke="#4c6e59" strokeWidth="4" strokeLinecap="round" />
    <path d={`M${-w + 9} ${y + 12}Q0 ${y + 4} ${w - 9} ${y + 12}`} fill="none" stroke="#b6b58d" strokeWidth="2" />
    {[-.7, -.45, -.2, .2, .45, .7].map((n) => <path key={n} d={`M${n * 25} ${y - height + 5}Q${n * w * .55} ${y - 15} ${n * w} ${y + 6}`} stroke="#91a48a" strokeWidth="1" opacity=".4" fill="none" />)}
  </g>
}

function Window({ x, y, width = 34, height = 44 }: { x: number; y: number; width?: number; height?: number }) {
  return <g transform={`translate(${x} ${y})`}>
    <rect width={width} height={height} fill="#526f5b" stroke="#b38359" strokeWidth="3" />
    <path d={`M${width / 2} 0V${height}M0 ${height / 2}H${width}M0 ${height / 4}H${width}M${width / 4} 0V${height}M${width * .75} 0V${height}`} stroke="#d0b687" strokeWidth="1.5" />
  </g>
}

function Lantern({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <path d="M0-10V0M0 35v12" stroke="#86553b" strokeWidth="2" />
    <rect x="-7" y="-2" width="14" height="4" rx="1" fill="#876144" />
    <path d="M-8 1c-17 5-17 27 0 32H8C25 28 25 6 8 1Z" fill="#b86045" />
    <path d="M-5 1C-11 9-11 25-5 33M5 1c6 8 6 24 0 32M0 1v32" stroke="#df9a63" strokeWidth="1.2" fill="none" />
    <rect x="-7" y="33" width="14" height="4" rx="1" fill="#876144" />
    <path d="M-3 45v7m3-7v9m3-9v7" stroke="#b86045" strokeWidth="1.2" />
  </g>
}

function Building({ kind, id }: { kind: LandmarkKind; id: string }) {
  if (kind === 'teahouse') return <g>
    <ellipse cy="13" rx="120" ry="22" fill="#315c4c" opacity=".12" />
    <path d="m-101 4 106-9 102 8-8 12H-92Z" fill="#dbcfac" stroke="#a9a78d" />
    <path d="M-77-80H78V5H-77Z" fill="#b4744f" />
    <path d="M-68-73H69V-11H-68Z" fill="#eee0ba" />
    {[-61, -15, 31].map((x) => <Window key={x} x={x} y={-68} width={32} height={48} />)}
    {[-80, -27, 27, 80].map((x) => <path key={x} d={`M${x}-84V6`} stroke="#7d4834" strokeWidth="6" />)}
    <Roof id={id} y={-78} width={228} height={43} />
    <path d="M-51-126H52v-35H-51Z" fill="#e8d7af" />
    {[-46, -11, 24].map((x) => <Window key={x} x={x} y={-158} width={23} height={26} />)}
    <Roof id={id} y={-155} width={168} height={43} />
    <path d="M-12-201c4 6 20 6 24 0M0-205v-12" fill="none" stroke="#365649" strokeWidth="3" strokeLinecap="round" />
    <path d="M-90-11H90M-90-3H90" stroke="#78553c" strokeWidth="3" />
    {Array.from({ length: 13 }, (_, i) => <path key={i} d={`M${-87 + i * 14}-12V5`} stroke="#8d6547" strokeWidth="2" />)}
    <Lantern x={-66} y={-71} scale={.4} /><Lantern x={65} y={-71} scale={.4} />
  </g>

  const restaurant = kind === 'restaurant'
  const candy = kind === 'candy'
  const width = restaurant ? 236 : candy ? 199 : 239
  return <g>
    <ellipse cy="12" rx={width / 2 + 6} ry="18" fill="#5a6249" opacity=".12" />
    <path d={`M${-width / 2 + 20} 2h${width - 40}l12 12h${-width + 16}Z`} fill="#d4cbb0" stroke="#b8ae91" />
    <rect x={-width / 2 + 23} y={-95} width={width - 46} height={99} fill={candy ? '#dbc898' : '#e5d5b4'} stroke="#b69a72" />
    <path d={`M${width / 2 - 45}-94h23V4h-23Z`} fill="#c7ae83" />
    {restaurant && <g>
      <path d="M-82-139H82v56H-82Z" fill="#e7dabc" />
      {[-71, -29, 13, 55].map((x) => <Window key={x} x={x} y={-135} width={26} height={36} />)}
      <Roof id={id} y={-139} width={207} height={42} />
      <path d="M-83-97H83" stroke="#9a5b42" strokeWidth="7" />
    </g>}
    <Roof id={id} y={-93} width={width} height={candy ? 47 : 39} />
    <rect x="-27" y="-68" width="54" height="70" fill="#435c49" />
    <rect x="-23" y="-66" width="46" height="67" fill="#3f4c3c" />
    <Window x={-78} y={-62} width={36} height={45} />
    <Window x={43} y={-62} width={34} height={45} />
    <path d={`M${-width / 2 + 27}-84V4M${width / 2 - 27}-84V4M-33-77V4M33-77V4`} stroke="#965b40" strokeWidth="6" />
    <rect x="-41" y="-88" width="82" height="18" rx="2" fill="#78543b" stroke="#c9a871" strokeWidth="1.5" />
    <path d="M-30-79H30" stroke="#d4bf88" strokeWidth="1.5" opacity=".7" />
    <Lantern x={-89} y={-73} scale={.47} /><Lantern x={88} y={-73} scale={.47} />
    {candy ? <g>
      <path d="M-77-20h35v16h-35ZM41-20h37v16H41Z" fill="#9b6546" />
      {[-68, -54, 48, 62].map((x, i) => <g key={x}><rect x={x} y={-31} width="10" height="12" rx="2" fill={i % 2 ? '#a7583e' : '#b89e56'} /><path d={`M${x}-29h10`} stroke="#e8cd93" strokeWidth="2" /></g>)}
    </g> : !restaurant && <g>
      <path d="M-80-16h38v16h-38ZM42-16h35v16H42Z" fill="#a87548" />
      <ellipse cx="-61" cy="-18" rx="20" ry="5" fill="#d8b97e" stroke="#997345" />
      <path d="M-77-26v8m32-8v8" stroke="#bc945f" strokeWidth="2" />
      <ellipse cx="-61" cy="-26" rx="18" ry="5" fill="#e6d09b" stroke="#997345" />
      <path d="M-67-32q-4-7 0-13m9 12q-4-7 0-13" stroke="#fff9e8" opacity=".8" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M48-35h23l3 20H45Z" fill="#d5b988" /><path d="M53-35v-7q7-8 12 0v7" stroke="#9b744c" fill="none" strokeWidth="2" />
    </g>}
  </g>
}

/** Decorative, editable landmark artwork. Interactive labels belong to the parent UI. */
export function Landmark({ kind, label = 'Illustrated garden landmark', className }: ArtProps & { kind: LandmarkKind }) {
  const id = `landmark-${useId().replace(/:/g, '')}`
  return <svg className={className} viewBox="-145 -225 290 255" role="img" aria-labelledby={`${id}-title`}>
    <title id={`${id}-title`}>{label}</title><ArtDefs id={id} /><Building kind={kind} id={id} />
  </svg>
}

/** Teaching map: inspired by garden architecture, not a survey or navigation map. */
export function GardenMap({ label = 'An illustrated garden with four learning destinations', className }: ArtProps) {
  const id = `garden-${useId().replace(/:/g, '')}`
  return <svg className={className} viewBox="0 0 1100 690" role="img" aria-labelledby={`${id}-title`} preserveAspectRatio="xMidYMid meet">
    <title id={`${id}-title`}>{label}</title><ArtDefs id={id} />
    <rect width="1100" height="690" fill="#f2eddf" />
    <path d="M0 183C96 162 99 75 196 98s96-13 142-33 96-18 134 11 125-7 186 4 64 64 123 43 106-23 136 11 101 15 183 39V0H0Z" fill="#e8e9d7" opacity=".62" />
    <path d="M0 577c115-20 137 14 190 25s118-12 159 7 95-9 155 21 136-1 191-14 146 14 211-19 136-10 194-26v119H0Z" fill="#e4e7d3" opacity=".7" />
    <Cloud x={161} y={58} scale={.8} /><Cloud x={487} y={105} scale={1.1} /><Cloud x={934} y={89} scale={.8} /><Cloud x={103} y={371} scale={.7} /><Cloud x={967} y={603} scale={.8} />

    <g id={`${id}-garden-walls`}>
      <path d="M96 215 148 178 220 199 312 147 387 177 438 152" fill="none" stroke="#c0bca0" strokeWidth="15" />
      <path d="M96 207 148 170 220 191 312 139 387 169 438 144" fill="none" stroke="#71836a" strokeWidth="5" />
      <path d="M638 146 691 119 771 147 829 116 939 161 981 215" fill="none" stroke="#d5cdb0" strokeWidth="15" />
      <path d="M638 138 691 111 771 139 829 108 939 153 981 207" fill="none" stroke="#71836a" strokeWidth="5" />
    </g>

    <g id={`${id}-lake-water`}>
      <path d="M584 288c50-36 83-21 118 1s64 27 101 5 96-7 104 36 64 38 93 88-4 97-50 109-76 27-122 42-115-6-153-38-102-27-116-64 19-61 2-93-15-57 23-86Z" fill="#d9debf" />
      <path d="M589 298c45-33 79-15 110 6s66 26 104 6 84-6 92 34 63 37 91 78-6 85-47 97-77 30-113 39-105-4-143-35-103-28-111-59 20-61 2-96-19-45 15-70Z" fill={`url(#${id}-water)`} />
      <path d="M617 320c37-17 56-4 86 7m-98 92c-15 23-8 46 10 56m78 45c34 24 73 34 108 23m74-200c7 29 28 37 49 51" stroke="#e4e9cc" strokeWidth="2" fill="none" opacity=".9" />
      {[{x:635,y:354,w:38},{x:888,y:414,w:50},{x:722,y:509,w:39},{x:921,y:476,w:30},{x:617,y:456,w:27},{x:848,y:537,w:25}].map(({x,y,w}) => <g key={x} stroke="#e6ead2" fill="none" strokeLinecap="round"><path d={`M${x} ${y}h${w}m${-w + 9} 7h${w / 2}`} strokeWidth="1.5" /></g>)}
      <g fill="#669c7e" stroke="#c1d4a8" strokeWidth="1"><path d="M922 448c-18-13-32-6-30 4 9 10 25 6 30-4Z" /><path d="M946 460c-15-14-29-9-30 0 4 11 21 10 30 0Z" /><path d="M899 465c-12-12-24-7-24 2 8 7 19 7 24-2Z" /></g>
      <path d="m922 445-1-8m-4 0 4-7 5 7-5 4Z" fill="#d39b89" stroke="#a77b6b" strokeWidth=".8" />
    </g>

    <g id={`${id}-paths`} fill="none" strokeLinecap="round">
      <path d="M234 286c-6 59 52 69 113 63s73-40 124-41 86 12 128-14 64-38 110-24M336 524c60 35 115 18 139-19s18-101 78-115M474 505c48 23 77 37 129 19" stroke="#e3dac3" strokeWidth="33" />
      <path d="M234 286c-6 59 52 69 113 63s73-40 124-41 86 12 128-14 64-38 110-24M336 524c60 35 115 18 139-19s18-101 78-115M474 505c48 23 77 37 129 19" stroke="#fcf5e6" strokeWidth="24" />
      <path d="M234 286c-6 59 52 69 113 63s73-40 124-41 86 12 128-14 64-38 110-24M336 524c60 35 115 18 139-19s18-101 78-115" stroke="#cdbfa4" strokeWidth="1.5" strokeDasharray="1 12" />
      <path d="M575 390 638 414 686 383 735 405 772 393" stroke="#d2cbb0" strokeWidth="27" strokeLinejoin="round" />
      <path d="M575 382 638 406 686 375 735 397 772 385" stroke="#f1e6cd" strokeWidth="21" strokeLinejoin="round" />
      <path d="M575 372 638 396 686 365 735 387 772 375" stroke="#968a6d" strokeWidth="3" strokeLinejoin="round" />
      <path d="M575 392 638 416 686 385 735 407 772 395" stroke="#968a6d" strokeWidth="3" strokeLinejoin="round" />
      {[{x:577,y:372},{x:608,y:384},{x:638,y:396},{x:664,y:379},{x:687,y:365},{x:710,y:376},{x:735,y:387},{x:770,y:375}].map(({x,y}) => <g key={x} stroke="#8c8064" strokeWidth="3"><path d={`M${x} ${y-8}v18M${x} ${y+12}v18`} /></g>)}
    </g>

    <g id={`${id}-back-planting`}>
      <Tree x={113} y={247} scale={.78} /><Pine x={402} y={219} scale={1.05} /><Tree x={469} y={248} scale={.67} />
      <Tree x={597} y={194} scale={.76} /><Pine x={897} y={221} scale={1.1} /><Tree x={965} y={278} scale={.85} />
      <Tree x={177} y={472} scale={1.05} /><Pine x={456} y={442} scale={1.05} /><Tree x={222} y={400} scale={.62} />
      <Rocks x={534} y={315} scale={.65} /><Rocks x={929} y={336} scale={.8} /><Rocks x={581} y={531} scale={.8} />
      <Tree x={975} y={567} scale={.72} /><Tree x={884} y={328} scale={.62} />
    </g>

    <g id={`${id}-restaurant`} transform="translate(250 290)"><Building kind="restaurant" id={id} /></g>
    <g id={`${id}-candy`} transform="translate(710 258)"><Building kind="candy" id={id} /></g>
    <g id={`${id}-nanxiang`} transform="translate(320 535)"><Building kind="nanxiang" id={id} /></g>
    <g id={`${id}-teahouse`} transform="translate(800 510)"><Building kind="teahouse" id={id} /></g>

    <g id={`${id}-front-planting`}>
      <Rocks x={140} y={305} scale={.7} /><Tree x={403} y={303} scale={.55} /><Tree x={578} y={274} scale={.51} />
      <Rocks x={211} y={559} scale={.65} /><Tree x={438} y={576} scale={.52} /><Tree x={918} y={552} scale={.64} />
      <path d="M109 555q12-12 24 0m-20 8q10-9 20 0M495 245q10-12 20 0m5 7q9-9 18 0M548 577q11-10 22 0M94 283q10-9 20 0" stroke="#a5ae84" strokeWidth="2" fill="none" strokeLinecap="round" />
    </g>
    <g opacity=".55" stroke="#9b9e7e" fill="none" strokeWidth="1.5" strokeLinecap="round">
      <path d="M517 182q6-6 12 0 6-6 12 0M537 169q5-5 10 0 5-5 10 0M104 112q5-5 10 0 5-5 10 0" />
    </g>
    <rect width="1100" height="690" fill={`url(#${id}-paper)`} pointerEvents="none" />
  </svg>
}

function Dumpling({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <ellipse cy="10" rx="23" ry="10" fill="#bda678" opacity=".35" />
    <path d="M-23 5c0-13 13-14 17-26 4-6 11-6 14 0C11-10 24-7 24 5c0 18-47 18-47 0Z" fill="#fff1ce" stroke="#d6bc87" strokeWidth="1" />
    <path d="M-5-19c-1 13-12 17-12 26M-1-19c2 15-5 20-5 29M4-19c0 15 7 18 8 28M8-17c3 9 10 12 10 21" stroke="#d8bf8e" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    <ellipse cx="1" cy="-20" rx="6" ry="3" fill="#ddc393" />
    <path d="M-16 10q15 7 30-1" stroke="#fff9e8" strokeWidth="2" fill="none" />
  </g>
}

function Steamer({ x, y, scale = 1, lid = false }: { x: number; y: number; scale?: number; lid?: boolean }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <ellipse cy="24" rx="118" ry="31" fill="#573d27" opacity=".13" />
    <path d="M-108-13v35c0 37 216 37 216 0v-35Z" fill="#bd9256" stroke="#947044" strokeWidth="2" />
    <path d="M-106 6c32 26 180 26 212 0M-106 20c32 28 180 28 212 0" stroke="#e3bf7c" strokeWidth="3" fill="none" />
    {[-94, -75, -48, -18, 18, 48, 75, 94].map((x) => <path key={x} d={`M${x} 5v28`} stroke="#99713f" strokeWidth="1.4" opacity=".5" />)}
    <ellipse cy="-13" rx="108" ry="36" fill="#e7c58b" stroke="#9e7745" strokeWidth="2" />
    <ellipse cy="-13" rx="96" ry="28" fill="#b08c57" />
    <ellipse cy="-12" rx="90" ry="24" fill="#d6ba82" />
    {lid ? <g>
      <ellipse cy="-17" rx="102" ry="32" fill="#d1ae72" stroke="#a37e49" strokeWidth="2" />
      {[-70, -49, -28, -7, 14, 35, 56, 77].map((x) => <path key={x} d={`M${x} -40v45`} stroke="#e6c78e" strokeWidth="3" opacity=".6" />)}
      <ellipse cy="-17" rx="90" ry="24" stroke="#9b7543" strokeWidth="1.3" fill="none" />
      <path d="M-14-25v-12q14-10 28 0v12" stroke="#9b7543" strokeWidth="5" fill="none" />
    </g> : <g>
      <Dumpling x={-43} y={-23} scale={.86} /><Dumpling x={13} y={-26} scale={.88} /><Dumpling x={62} y={-12} scale={.87} />
      <Dumpling x={-59} y={1} scale={.92} /><Dumpling x={-7} y={5} scale={.96} /><Dumpling x={42} y={8} scale={.9} />
    </g>}
    <path d="M-108-13c0 20 47 37 108 37s108-17 108-37" stroke="#e5c58a" strokeWidth="6" fill="none" />
    <path d="M-108-11c0 20 47 37 108 37s108-17 108-37" stroke="#98713f" strokeWidth="1.4" fill="none" />
  </g>
}

function PaperBag({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <ellipse cx="4" cy="92" rx="66" ry="13" fill="#5b412a" opacity=".13" />
    <path d="M-44-26H39l13 113H-55Z" fill="#d8bb83" stroke="#ab8656" strokeWidth="1.5" />
    <path d="M39-26 58-17 69 77 52 87Z" fill="#b99b67" />
    <path d="M-44-26-29-16H58L39-26Z" fill="#ebd6aa" />
    <path d="M-24-23v-28c0-28 43-28 43 0v28" stroke="#936c43" strokeWidth="4" fill="none" />
    <path d="M-15-17v-28c0-27 43-27 43 0v28" stroke="#c7a36c" strokeWidth="4" fill="none" />
    <circle cx="0" cy="38" r="24" fill="none" stroke="#937b4c" strokeWidth="1.5" />
    <path d="M-17 41q17-19 34 0m-28-5 11-14 11 14M-18 47h36M-9 36v11M9 36v11M-4 38v9M4 38v9" stroke="#937b4c" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    <path d="M-43 76h84M-43 80h84" stroke="#ae8c57" strokeWidth="1" opacity=".5" />
  </g>
}

function Shopkeeper({ pose }: { pose: ScenePose }) {
  return <g>
    <path d="M493 337c-2-72 15-112 43-122 23-10 53-10 78 0 35 16 49 72 53 122Z" fill="#486755" />
    <path d="M537 218 555 207h42l20 13-14 35h-51Z" fill="#f4e5c7" />
    <path d="M556 190v33c5 17 34 18 41-1v-34" fill="#dba77f" />
    <path d="M552 208c12 10 33 10 47-1v-13h-47Z" fill="#c68d69" opacity=".4" />
    <path d="M546 220 528 241l16 106h67l18-106-22-22-6 27h-49Z" fill="#e4ccb0" />
    <path d="M550 248h52l15 97h-81Z" fill="#ecd9bb" />
    <path d="M555 285h41v30c-11 7-30 7-41 0Z" fill="#d6bd99" stroke="#c3a783" />
    <path d="M558 289h35" stroke="#f4e4c9" strokeWidth="2" />
    <path d="M527 227c-17 11-21 37-23 58l-14 55 34 6 19-56" fill="#486755" />
    <path d="M621 227c18 12 25 36 27 59l21 51-31 9-22-58" fill="#486755" />
    <path d="m500 315 29 5-8 25-31-6Zm137 4 28-8 8 27-31 9Z" fill="#f2dfbf" />
    <path d="M519 340c-14-2-23-1-27 9-4 7 3 13 14 11l45-9c10-1 14-7 4-11-10-3-20 4-36 0Z" fill="#e4b48e" stroke="#ce9873" strokeWidth="1.2" />
    {pose === 'welcome' || pose === 'listening' ? <g>
      <path d="M647 334c6-10 7-25 3-37l-15-24c-5-11 1-14 6-7l9 12-4-27c-1-10 5-11 7-2l5 23 1-31c0-9 6-8 7 0l1 31 5-24c2-8 7-6 6 3l-3 25 6-15c3-7 8-4 5 4l-10 29c-5 20-2 29-9 42Z" fill="#e4b48e" stroke="#ce9873" strokeWidth="1.2" />
      <path d="M649 280c7 1 12 8 13 16" stroke="#c88f6b" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </g> : <path d="M648 339c15-4 24-2 28 7 4 8-2 13-14 12l-45-8c-11-2-12-9-2-11 11-3 18 4 33 0Z" fill="#e4b48e" stroke="#ce9873" strokeWidth="1.2" />}
    <ellipse cx="573" cy="144" rx="50" ry="63" fill="#363c31" />
    <path d="M534 155c-15-14-22 9-8 20l12 4m75-24c15-14 22 9 8 20l-12 4" fill="#dca780" />
    <path d="M534 124c10-22 63-27 80 2v43c-2 34-20 49-41 49-23 0-40-20-40-49Z" fill="#e9ba92" />
    <path d="M531 151c-1-21 2-39 13-47 15-11 44-10 59 3 14 11 17 24 11 46-3-17-11-24-18-38-15 17-41 22-65 36Z" fill="#393e32" />
    <path d="M540 108c16-24 55-18 65 7" fill="none" stroke="#68694e" strokeWidth="3" strokeLinecap="round" />
    <path d="M543 157q7-5 14-1m31 0q7-4 13 1" stroke="#6d4f3b" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M545 166q5-4 10 0m35 0q5-4 10 0" stroke="#424538" strokeWidth="2.6" fill="none" strokeLinecap="round" />
    <path d="m573 165-4 15q4 4 9 0" stroke="#c58d6b" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    <path d="M558 190q15 14 30-1" fill="#fff0d5" stroke="#a86b52" strokeWidth="1.6" strokeLinecap="round" />
    <ellipse cx="546" cy="181" rx="9" ry="5" fill="#d98d76" opacity=".42" /><ellipse cx="599" cy="181" rx="9" ry="5" fill="#d98d76" opacity=".42" />
    <circle cx="531" cy="178" r="3" fill="#d7b262" /><circle cx="617" cy="178" r="3" fill="#d7b262" />
  </g>
}

/** Original teaching interior. `packed` is a presentation pose, never a progress signal. */
export function NanxiangScene({ label = 'A welcoming server at a warm wooden dumpling counter', className, pose = 'welcome' }: ArtProps & { pose?: ScenePose }) {
  const id = `nanxiang-${useId().replace(/:/g, '')}`
  return <svg className={className} viewBox="0 0 1100 580" role="img" aria-labelledby={`${id}-title`} preserveAspectRatio="xMidYMid slice">
    <title id={`${id}-title`}>{label}</title><ArtDefs id={id} />
    <rect width="1100" height="580" fill="#ead9b8" />
    <path d="M0 0h1100v91H0Z" fill="#503f2d" />
    <path d="M0 14h1100v18H0ZM0 68h1100v13H0Z" fill="#8c6443" />
    <path d="M0 34h1100v6H0ZM0 85h1100v9H0Z" fill="#b38a59" />
    <path d="M41 0v88M1059 0v88M235 0v88M864 0v88" stroke="#b18a5c" strokeWidth="13" />
    <path d="M53 0v88M1048 0v88M246 0v88M852 0v88" stroke="#382e24" strokeWidth="3" opacity=".55" />

    <g id={`${id}-window-architecture`}>
      <rect x="90" y="103" width="921" height="258" fill="#b8895c" />
      <rect x="106" y="115" width="889" height="229" fill={`url(#${id}-light)`} />
      <path d="M106 281c74-34 79-80 141-88s76 58 119 44 70-69 127-47 97 82 147 63 107-40 151-10 131-45 204-22v123H106Z" fill="#bdc2a2" opacity=".42" />
      <path d="M158 328c5-50 29-68 43-110m-22 47-36-18m53-15 31-22m654 118c0-40 16-63 29-93m-16 35 31-11" stroke="#9fa989" fill="none" strokeWidth="4" opacity=".45" />
      <rect x="106" y="115" width="889" height="229" fill={`url(#${id}-lattice)`} opacity=".83" />
      {[106, 287, 464, 642, 820, 992].map((x) => <g key={x}><rect x={x} y="107" width="9" height="244" fill="#81583e" /><rect x={x + 2} y="107" width="2" height="244" fill="#c79765" /></g>)}
      <path d="M99 137h903M99 320h903" stroke="#81583e" strokeWidth="8" />
      <path d="M107 139h887M107 322h887" stroke="#c79765" strokeWidth="2" />
      <rect x="77" y="100" width="18" height="277" fill="#8a563b" /><rect x="1009" y="100" width="18" height="277" fill="#8a563b" />
      <rect x="81" y="100" width="3" height="277" fill="#bc8657" /><rect x="1013" y="100" width="3" height="277" fill="#bc8657" />
      <path d="M85 357h935v20H85Z" fill="#956947" /><path d="M85 357h935v5H85Z" fill="#c39861" />
    </g>

    <g id={`${id}-lighting`}>
      <ellipse cx="244" cy="172" rx="129" ry="160" fill={`url(#${id}-glow)`} />
      <ellipse cx="853" cy="172" rx="129" ry="160" fill={`url(#${id}-glow)`} />
      {[244, 853].map((x) => <g key={x} transform={`translate(${x} 110)`}>
        <path d="M0-76V-25" stroke="#51462e" strokeWidth="3" />
        <path d="M-24-24h48l11 57c-7 13-63 13-70 0Z" fill="#f1d99b" stroke="#a98750" strokeWidth="2" />
        <path d="M-18-24-23 36M-8-24-10 41M8-24l2 65M18-24l5 60" stroke="#c2a162" strokeWidth="1.5" />
        <path d="M-27-24h54M-34 33h68" stroke="#8f6c40" strokeWidth="4" /><path d="M0 44v14" stroke="#9c7046" strokeWidth="3" />
      </g>)}
    </g>

    <g id={`${id}-back-counter`}>
      <rect x="97" y="337" width="909" height="65" fill="#c49a68" /><path d="M91 337h922v9H91Z" fill="#805b3e" />
      <g transform="translate(164 330)">
        <path d="M-25-2v-49c0-11 50-11 50 0v49Z" fill="#59745e" /><ellipse cy="-51" rx="25" ry="8" fill="#adc1a0" stroke="#49634f" /><path d="M-22-42q22 10 44 0M-23-9q23 10 46 0" fill="none" stroke="#99ad88" strokeWidth="2" />
        <path d="M-12-54-17-99M0-56l4-51M12-54l17-43" stroke="#9c7650" strokeWidth="4" />
      </g>
      <g transform="translate(933 332)"><path d="M-29-3q-12-18 0-48H29Q41-21 29-3Z" fill="#788c71" stroke="#526b55" strokeWidth="2" /><ellipse cy="-52" rx="29" ry="7" fill="#a7b49a" /><path d="M-19-54q-17-31-12-51m33 51q20-37 13-65M-5-54q-4-50-21-65" stroke="#75805c" strokeWidth="2" fill="none" /><path d="M-31-92q-27-6-20-20 21-1 20 20m34 20q25-14 31-3-15 16-31 3m10-32q17-24 29-15-7 19-29 15m-28 24q-24-19-13-28 19 6 13 28" fill="#8a9a71" /></g>
      <g transform="translate(350 330)"><ellipse cy="-1" rx="47" ry="10" fill="#8f7350" opacity=".25" /><path d="M-43-12q43 14 86 0v10q-43 14-86 0Z" fill="#ece1c4" stroke="#b3ac8c" /><ellipse cy="-13" rx="43" ry="9" fill="#f8eed5" stroke="#b3ac8c" /><path d="M-36-25q36 10 72 0v9q-36 12-72 0Z" fill="#e5d7b5" stroke="#b3ac8c" /><ellipse cy="-25" rx="36" ry="8" fill="#f8eed5" stroke="#b3ac8c" /></g>
    </g>

    <g id={`${id}-original-character`}><Shopkeeper pose={pose} /></g>

    <g id={`${id}-front-counter`}>
      <path d="M0 369H1100V580H0Z" fill={`url(#${id}-counter)`} />
      <path d="M52 347h996l52 41H0Z" fill="#c29964" />
      <path d="M0 388h1100v14H0Z" fill="#724b33" /><path d="M0 390h1100v4H0Z" fill="#e0b77d" />
      <path d="M63 356h975M37 373h1025" stroke="#b18a59" strokeWidth="1.4" />
      <path d="M40 424h1020v156H40Z" fill="#8b5a3d" stroke="#bf905e" strokeWidth="5" />
      <path d="M56 439h988v141H56Z" fill="none" stroke="#6f472f" strokeWidth="2" />
      <path d="M278 424v156M553 424v156M828 424v156" stroke="#bc8b58" strokeWidth="7" />
      <path d="M287 432v148M562 432v148M837 432v148" stroke="#6f472f" strokeWidth="2" />
      <path d="M86 469q37-10 84 1t73-1M86 482q62-5 130 3M311 520q58-12 134 0t77-2M589 466q67-10 132 1t72-1M868 517q49-9 143 3M84 550q41-7 105-2" stroke="#d0a16c" strokeWidth="1.3" fill="none" opacity=".25" />
    </g>

    <g id={`${id}-serving-props`}>
      <Steamer x={285} y={350} scale={.88} lid />
      <Steamer x={285} y={319} scale={.88} lid />
      <Steamer x={410} y={391} scale={1.12} />
      <Steamer x={650} y={394} scale={1.04} lid={pose === 'packed'} />
      <PaperBag x={841} y={302} scale={.91} />
      <g transform="translate(178 386)"><ellipse cy="4" rx="41" ry="12" fill="#69482f" opacity=".15" /><path d="M-35-5q35-9 70 0l-7 14q-29 13-58 0Z" fill="#e2dcc2" stroke="#818d71" strokeWidth="1.5" /><ellipse cy="-5" rx="35" ry="10" fill="#f5edd2" stroke="#818d71" /><ellipse cy="-5" rx="23" ry="6" fill="#7d5234" /><path d="m12-7 11 2m-31-1 12 3" stroke="#c39a5f" strokeWidth="1.4" /></g>
      <path d="m910 376 86 29m-89-22 86 29" stroke="#503e2b" strokeWidth="4" strokeLinecap="round" /><path d="m909 376 22 7m-22 0 20 7" stroke="#c4a26d" strokeWidth="4" strokeLinecap="round" />
    </g>
    <g className="scene-steam" fill="none" stroke="#fff6df" strokeWidth="4" strokeLinecap="round" opacity=".7">
      <path d="M380 317c-18-22 14-25-1-49" /><path d="M417 307c-15-22 16-27 0-51" /><path d="M453 319c-15-21 13-26 0-45" />
      {pose !== 'packed' && <><path d="M628 323c-14-24 14-27 0-49" /><path d="M665 313c-15-22 13-26 0-49" /></>}
    </g>
    <rect width="1100" height="580" fill={`url(#${id}-paper)`} pointerEvents="none" />
  </svg>
}
