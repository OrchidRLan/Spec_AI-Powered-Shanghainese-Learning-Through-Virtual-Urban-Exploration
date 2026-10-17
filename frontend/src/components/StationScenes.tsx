import { useId } from 'react'
import type { ScenePose } from './SceneArt'
import '../station-scenes.css'

export type IllustratedStation = 'restaurant' | 'candy' | 'teahouse'
type ArtProps = { label?: string; className?: string }
export type StationSceneProps = ArtProps & {
  station: IllustratedStation
  pose?: ScenePose
  selectedDish?: string | null
  selectedFlavor?: string | null
  completed?: boolean
}

const flavors = ['rose', 'osmanthus', 'mint'] as const
const dishes = ['fish', 'chicken', 'tofu'] as const
const flavorColors: Record<string, { ink: string; paper: string; light: string }> = {
  rose: { ink: '#995b69', paper: '#ead2c8', light: '#f4e4dc' },
  osmanthus: { ink: '#a77b36', paper: '#ead7a8', light: '#f5ead0' },
  mint: { ink: '#4b7969', paper: '#c9ddc9', light: '#e2ebd8' },
}

function SceneDefs({ id }: { id: string }) {
  return <defs>
    <linearGradient id={`${id}-wall`} x2="0" y2="1"><stop stopColor="#f4ead7" /><stop offset="1" stopColor="#dfc7a2" /></linearGradient>
    <linearGradient id={`${id}-wood`} x2="0" y2="1"><stop stopColor="#bc8c5d" /><stop offset="1" stopColor="#815339" /></linearGradient>
    <linearGradient id={`${id}-glass`} x2="0" y2="1"><stop stopColor="#e9efe0" stopOpacity=".5" /><stop offset="1" stopColor="#b5cec0" stopOpacity=".22" /></linearGradient>
    <linearGradient id={`${id}-sky`} x2="0" y2="1"><stop stopColor="#e8eee0" /><stop offset="1" stopColor="#c6d8ca" /></linearGradient>
    <linearGradient id={`${id}-water`} x2="0" y2="1"><stop stopColor="#adcbbb" /><stop offset="1" stopColor="#709e90" /></linearGradient>
    <radialGradient id={`${id}-light`}><stop stopColor="#fff2c7" stopOpacity=".9" /><stop offset="1" stopColor="#fff2c7" stopOpacity="0" /></radialGradient>
    <pattern id={`${id}-grain`} width="27" height="29" patternUnits="userSpaceOnUse"><circle cx="6" cy="8" r=".7" fill="#6f634d" opacity=".13" /><path d="M18 18h2M3 26h2" stroke="#fffaf0" strokeOpacity=".26" /></pattern>
    <pattern id={`${id}-lattice`} width="48" height="48" patternUnits="userSpaceOnUse"><path d="M0 0h48v48H0ZM12 0v36h36M0 12h36v36M12 12h24v24H12Z" fill="none" stroke="#8c6b49" strokeWidth="3" /></pattern>
    <pattern id={`${id}-shelf-pattern`} width="18" height="18" patternUnits="userSpaceOnUse"><path d="M0 9h18M9 0v18" stroke="#e5cda7" strokeWidth=".8" opacity=".25" /></pattern>
  </defs>
}

function FlavorFlower({ flavor }: { flavor: string }) {
  if (!flavors.includes(flavor as typeof flavors[number])) return <g fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M-16 16c-13-9-10-23-2-30 8-8 4-21 17-21 14 0 11 13 18 21 11 13 10 26-2 32-10 5-22 4-31-2Z" /><path d="M0-35q1-13 11-18M0-39q-13-12-20-5 7 11 20 5" /></g>
  if (flavor === 'rose') return <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M-5 22C-2 10 2 3 0-10M-3 12c-13 1-21-4-22-12 13-2 20 3 22 12M-3 17c12 0 22-8 22-16-13-1-20 5-22 16" />
    <path d="M0-11c-15 11-31-3-24-14-7-11 5-25 17-19 9-11 25-5 24 6 15 4 17 22 5 27-7 11-17 6-22 0Z" fill="currentColor" fillOpacity=".13" />
    <path d="M0-12c-12-2-17-14-10-21 10-8 24-2 21 9-3 8-15 11-19 2-2-5 4-9 9-6M-22-25q5 13 16 9M-7-44q-2 9 6 12M17-38q-11-1-14 7M22-11q-6-5-11-8" />
  </g>
  if (flavor === 'osmanthus') return <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M-10 24 6-19M-3 8l-21-20M2-7l22-14M-5 14c-15 3-24-4-25-10 14-2 23 3 25 10M2-2c11 1 21 8 22 16C10 14 2 8 2-2" />
    {[[-20, -25], [5, -33], [24, -17], [-7, -10]].map(([x, y]) => <g key={`${x}-${y}`} transform={`translate(${x} ${y})`} fill="currentColor" fillOpacity=".28"><path d="M0 0C-17-1-11-15-3-8c-2-15 13-14 10-3 15-2 14 12 2 10 8 13-7 18-9 1Z" /><circle r="2.4" fill="currentColor" /></g>)}
  </g>
  return <g fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round" strokeLinecap="round">
    <path d="M-4 24C-3 5 1-13 10-34" fill="none" />
    <path d="M-1 12C-25 15-32 3-28-13-8-12 1-2-1 12ZM3-4C22-6 33-20 28-36 8-33 1-21 3-4ZM9-23C-7-25-14-41-7-52 9-47 14-37 9-23Z" />
    <path d="m-24-8 21 17M7-10l17-20M9-27-13-16M-15-6l-1 9M-9 1l-11 0M15-19l9 0M18-23l-1-9" fill="none" strokeWidth="1.5" />
  </g>
}

function CandyPacket({ flavor }: { flavor: string }) {
  const color = flavorColors[flavor] || { ink: '#8b805b', paper: '#ddcfaa', light: '#eee2c4' }
  return <g style={{ color: color.ink }}>
    <ellipse cx="80" cy="178" rx="60" ry="10" fill="#554b37" opacity=".12" />
    <path d="m34 32 13-18h70l11 18 8 137q-56 15-112 0Z" fill={color.paper} stroke={color.ink} strokeWidth="1.7" />
    <path d="M36 32h91l-6 11H40Z" fill={color.ink} opacity=".72" />
    <path d="M47 15h70l-8 9H54Z" fill={color.light} /><path d="M38 29h86M29 159q51 12 102 0" stroke={color.ink} strokeWidth="1.5" opacity=".55" />
    <path d="m35 44-5 111 13-5 6-105ZM120 45l9 110-12-5-7-105Z" fill={color.light} opacity=".6" />
    <rect x="45" y="53" width="70" height="91" rx="25" fill={color.light} stroke={color.ink} strokeWidth="1.1" />
    <g transform="translate(80 111) scale(.83)"><FlavorFlower flavor={flavor} /></g>
    <path d="M60 133h40M63 137h34" stroke={color.ink} strokeWidth="1" opacity=".5" />
    <path d="M44 44q36 6 73 0M35 164q45 10 91 0" fill="none" stroke="#fff9e9" strokeWidth="2" opacity=".7" />
  </g>
}

/** Equal-sized packages for the three choices; the component knows no listening target. */
export function CandyIllustration({ flavor, label, className }: ArtProps & { flavor: string }) {
  const titleId = `candy-choice-${useId().replace(/:/g, '')}`
  return <svg className={`bc-candy-illustration${className ? ` ${className}` : ''}`} viewBox="0 0 160 190" role={label ? 'img' : undefined} aria-hidden={label ? undefined : true} aria-labelledby={label ? titleId : undefined} focusable="false">
    {label && <title id={titleId}>{label}</title>}<CandyPacket flavor={flavor} />
  </svg>
}

function Plate() {
  return <g><ellipse cx="110" cy="109" rx="100" ry="21" fill="#5d5e49" opacity=".13" /><ellipse cx="110" cy="85" rx="102" ry="42" fill="#c9d4c0" stroke="#738d7c" strokeWidth="2" /><ellipse cx="110" cy="80" rx="102" ry="39" fill="#f4eedb" stroke="#9caf9a" strokeWidth="1.5" /><ellipse cx="110" cy="80" rx="87" ry="28" fill="#e4e4ce" stroke="#88a08b" strokeWidth="1.4" /><path d="M27 91q83 43 166 0" stroke="#becbb2" strokeWidth="2" fill="none" /></g>
}

function DishContent({ dish }: { dish: string }) {
  if (!dishes.includes(dish as typeof dishes[number])) return <Plate />
  return <g><Plate />{dish === 'fish' ? <g>
    <ellipse cx="108" cy="81" rx="75" ry="18" fill="#9d7f45" opacity=".48" />
    <path d="m157 72 35-21-7 26 9 21-38-13" fill="#718977" stroke="#557363" strokeWidth="2" />
    <path d="M29 79c19-31 90-43 137-3-33 34-104 33-137 3Z" fill="#a0b1a0" stroke="#5c7969" strokeWidth="2" />
    <path d="M48 68c18-11 75-21 110 7-26 15-74 19-103 10" fill="#c8d0b4" />
    <path d="m59 57 16-16 51 2 11 13m-39 33-2 17 30-13" fill="#8d9d86" stroke="#597767" strokeWidth="1.6" />
    <path d="M63 61q15 15 0 30M79 64q10 7 0 14m16-17q10 7 0 14m16-13q10 7 0 14m16-10q10 7 0 14M39 82l12-1" stroke="#667e6b" fill="none" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="47" cy="74" r="4" fill="#394f45" /><circle cx="46" cy="73" r="1.3" fill="#f7f2d9" />
    <path d="m67 65 67 18M75 83l60-22M88 57l39 30" stroke="#50794f" strokeWidth="4" strokeLinecap="round" /><path d="m79 61 48 16M86 84l37-21" stroke="#c1c97d" strokeWidth="2" strokeLinecap="round" />
    <path d="m47 104 19-6m68 4 17-4m-31-44 16 3" stroke="#50794f" strokeWidth="3" strokeLinecap="round" />
  </g> : dish === 'chicken' ? <g>
    <ellipse cx="110" cy="82" rx="72" ry="21" fill="#ceb46c" opacity=".5" />
    {[{x:61,y:71,r:-13},{x:83,y:65,r:-8},{x:105,y:64,r:0},{x:127,y:67,r:9},{x:149,y:75,r:17}].map(({x,y,r}) => <g key={x} transform={`translate(${x} ${y}) rotate(${r})`}><path d="M-13-13q13-10 25 0l5 30q-17 12-34 0Z" fill="#eacb7d" stroke="#b29150" strokeWidth="1.3" /><path d="M-11-5q11-7 21-1l3 19q-12 8-26 0Z" fill="#f2e5bd" /><path d="M-4-5q-5 11 0 20M5-6q-4 11 1 18" stroke="#d4c59b" strokeWidth="1.3" fill="none" /></g>)}
    <path d="M144 94q11-7 18-2l14 7-6 12-18-10-9 1" fill="#e5c77e" stroke="#a68a56" strokeWidth="1.3" /><ellipse cx="175" cy="106" rx="8" ry="5" fill="#f3e8cb" />
    <path d="M43 88q-12-8-18 0 8 8 18 0m-3 4q-15 0-12 11 11 0 12-11m9 1q3 10 13 5-2-9-13-5" fill="#668459" />
    <path d="m48 100 4-17m-10 4 11-3m-5 13 12 1" stroke="#4e6e47" strokeWidth="1.5" fill="none" />
  </g> : <g>
    <ellipse cx="111" cy="80" rx="76" ry="25" fill="#b96443" />
    {[[54,72],[80,59],[107,57],[136,62],[157,77],[72,88],[102,79],[130,89],[103,99]].map(([x,y],i) => <g key={x + '-' + y} transform={`translate(${x} ${y}) rotate(${i % 2 ? -8 : 9})`}><path d="m-12-9 23-3 4 20-25 4Z" fill="#e8c58a" stroke="#b27548" strokeWidth="1.2" /><path d="m-12-9 3 8 23-4-3-7Z" fill="#f4da9f" /><path d="m-9-1-1 13 25-4-1-13Z" fill="#d9ad70" /></g>)}
    {[[64,63],[89,83],[122,63],[143,82],[116,96],[50,87]].map(([x,y]) => <path key={x+'-'+y} d={`M${x} ${y}l7 2`} stroke="#55734b" strokeWidth="3" strokeLinecap="round" />)}
    <path d="M151 56q21-7 24 9-14 1-24-9M51 97q-17-8-14-19 13 5 14 19" fill="#a94135" /><path d="m152 57-6-4m-95 44 5 3" stroke="#5f7748" strokeWidth="2" />
  </g>}</g>
}

export function DishIllustration({ dish, label, className }: ArtProps & { dish: string }) {
  const titleId = `dish-choice-${useId().replace(/:/g, '')}`
  return <svg className={`bc-dish-illustration${className ? ` ${className}` : ''}`} viewBox="0 0 220 140" role={label ? 'img' : undefined} aria-hidden={label ? undefined : true} aria-labelledby={label ? titleId : undefined} focusable="false">
    {label && <title id={titleId}>{label}</title>}<DishContent dish={dish} />
  </svg>
}

function TeaCup({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <ellipse cy="24" rx="48" ry="12" fill="#587065" opacity=".13" /><ellipse cy="19" rx="43" ry="12" fill="#dbe4d6" stroke="#7c9d8c" strokeWidth="1.5" /><path d="M-29-8q0 31 29 32Q29 23 29-8Z" fill="#d6e3d4" stroke="#71947f" strokeWidth="1.8" /><ellipse cy="-8" rx="29" ry="9" fill="#f4f1de" stroke="#71947f" strokeWidth="1.8" /><ellipse cy="-7" rx="23" ry="5.5" fill="#b7aa63" /><path d="M-24 3q24 13 48 0M-14 16q14 7 28 0" stroke="#adc3ab" strokeWidth="2" fill="none" /><path d="M-11-8q7-2 11 0" stroke="#f0e4a5" strokeWidth="1.3" fill="none" />
  </g>
}

function TeaPot() {
  return <g>
    <path d="M41-12c49-31 57 35 8 36" fill="none" stroke="#537b67" strokeWidth="12" /><path d="M42-12c46-27 48 30 6 34" fill="none" stroke="#a6bda2" strokeWidth="5" />
    <path d="M-36 4c-23 0-39-12-44-30l-17 1c8 33 27 56 64 54Z" fill="#82a08a" stroke="#527863" strokeWidth="2" />
    <path d="M-45-9C-64 7-47 45-1 45c45 0 63-36 43-54Z" fill="#8aa88e" stroke="#527863" strokeWidth="2" /><ellipse cy="-8" rx="44" ry="14" fill="#acc1a2" stroke="#527863" strokeWidth="2" /><path d="M-33-11q5-18 33-18t33 18Z" fill="#b3c7aa" stroke="#527863" strokeWidth="1.8" /><ellipse cy="-30" rx="8" ry="5" fill="#60816a" /><path d="M-28 11q27 14 57 0M-18 31q18 7 37 0" fill="none" stroke="#bfd0b1" strokeWidth="2" opacity=".8" /><path d="M-3-2q-17 14-9 28M-14 6q13-2 18 10M-9 14q-15 0-17 9" stroke="#567d62" strokeWidth="1.6" fill="none" />
  </g>
}

function Steam({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`} fill="none" stroke="#fff7dd" strokeWidth="3" strokeLinecap="round" opacity=".75" aria-hidden="true"><path className="bc-steam bc-steam-one" d="M-17 0c-15-18 15-27 1-46" /><path className="bc-steam bc-steam-two" d="M9-2c-16-20 16-30 4-53" /></g>
}

function Host({ station, pose }: { station: IllustratedStation; pose: ScenePose }) {
  const restaurant = station === 'restaurant'
  const candy = station === 'candy'
  const clothes = restaurant ? '#985847' : candy ? '#a76e62' : '#567e6c'
  const sleeve = restaurant ? '#eee0c5' : candy ? '#c48d78' : '#88a58c'
  const listening = pose === 'listening'
  const thinking = pose === 'thinking' || pose === 'checking'
  const serving = pose === 'packing' || pose === 'packed'
  return <g className="bc-host">
    {station === 'teahouse' && <path d="M-20-154c-61-21-67 74-43 98l34-6Z" fill="#3d4439" />}
    <path d="M-82 86-77-10q4-65 45-73h64q43 8 48 73l3 96Z" fill={clothes} />
    <path d="M-30-108v35q31 29 60 0v-35" fill="#dba77e" /><path d="M-30-87q31 19 60 0v-14h-60Z" fill="#c78f68" opacity=".4" />
    {restaurant ? <><path d="M-34-84-11-61-27-38-47-73ZM34-84 11-61l16 23 20-35Z" fill="#f5e9d1" /><path d="M-11-61V84H12V-61" fill="#743f33" /><path d="M-11 9h23M-11 35h23M-11 61h23" stroke="#bc9470" strokeWidth="2.2" /><path d="M32-12h27v28H32Z" fill="#793f34" /><path d="M34-13h23" stroke="#dfbc8b" strokeWidth="3" /></> : candy ? <><path d="m-31-81-13 26L-58 86H59L44-55 31-81 25-47h-50Z" fill="#e5cba3" /><path d="M-27-39h54l14 125h-83Z" fill="#f0dcc0" /><path d="M-21 23h42v30q-22 13-42 0Z" fill="#d7b88f" /><path d="m-17 28 33 0" stroke="#f7e7ca" strokeWidth="2" /></> : <><path d="m-34-82 32 41 35-41 16 17-49 52-50-51Z" fill="#d9e4cb" /><path d="M0-13V87" stroke="#b7ccb3" strokeWidth="3" /><path d="M-2-4h13m-13 18h13m-13 18h13" stroke="#324f42" strokeWidth="3" strokeLinecap="round" /></>}
    <g className="bc-host-left-arm">
      <path d="M-68-60c-19 6-26 40-29 67l-18 52 35 11 25-58 7-60Z" fill={sleeve} /><path d="m-111 51 33 12-5 17-35-11Z" fill={restaurant ? '#d6bb91' : '#e5d5b8'} />
      <path d={serving ? 'M-94 73c16-5 44-12 59-5 8 4 5 11-5 11l-29-1c-15 10-25 10-36 3Z' : 'M-103 76q-17 5-15 14c3 10 20 7 30 4l28-7c9-3 8-10-2-11l-21 3Z'} fill="#e7b68d" stroke="#ca926c" strokeWidth="1" />
    </g>
    <g className="bc-host-right-arm">
      {listening ? <><path d="M66-62q31 6 35 52l-10 23-29-18-12-41Z" fill={sleeve} /><path d="M85 9c18 0 24-9 20-22L83-84 61-75 74-7Z" fill={sleeve} /><path d="m61-80 23-8 4 14-24 8Z" fill="#e8d9bd" /><path d="M64-81c-6-10-3-21-4-30l-6-12c-3-6 1-10 6-5l5 7-1-23c0-7 5-8 7-1l2 22 3-24c1-6 6-5 6 1v24l5-16c2-6 7-4 5 2l-3 21c-1 12-6 20-6 29Z" fill="#e7b68d" stroke="#ca926c" strokeWidth="1" /></> : thinking ? <><path d="M65-63q27 10 32 59c-6 13-20 15-32 4L32-52 48-68 76-33" fill={sleeve} /><path d="m29-53 21-18-7-11-22 18Z" fill="#e8d9bd" /><path d="M21-67c-13-5-18-13-14-24l8-14c3-5 8-3 6 2l-2 8 11-7c6-5 11 1 5 5l-9 10 11 8Z" fill="#e7b68d" stroke="#ca926c" strokeWidth="1" /></> : serving ? <><path d="M65-63q25 7 32 46l18 77-32 11-24-67-12-51Z" fill={sleeve} /><path d="m81 57 33-10 6 17-34 11Z" fill="#e8d9bd" /><path d="M99 72c-17-6-43-12-59-5-8 4-5 11 5 11l28-1c16 9 26 10 37 2Z" fill="#e7b68d" stroke="#ca926c" strokeWidth="1" /></> : <><path d="M66-62q26 7 31 43l6 23 39-13 14 29-48 20c-18 7-28-4-31-18L50-48Z" fill={sleeve} /><path d="m138-12 16 31 12-7-15-29Z" fill="#e8d9bd" /><path d="M151-16c8-5 15-11 20-19 4-6 9-2 6 4l-6 10 20-7c6-2 9 3 3 6l-18 8 23-3c7-1 8 5 1 6l-23 5 17 1c6 0 5 6-1 6l-23 1-9 5Z" fill="#e7b68d" stroke="#ca926c" strokeWidth="1" /></>}
    </g>
    <g className="bc-host-head">
      {candy && <><circle cx="21" cy="-202" r="27" fill="#4d4035" /><path d="M0-207q22-21 44 2" stroke="#9c7962" strokeWidth="3" fill="none" /><path d="m1-204 41-5" stroke="#c4a267" strokeWidth="3" /></>}
      <path d="M-49-155c-4-46 18-65 51-65 41 0 55 33 47 70l-8 40h-79Z" fill={restaurant ? '#453b31' : '#3d4439'} />
      <path d="M-41-150c-13-11-20 10-7 20l10 2m79-22c13-11 20 10 7 20l-10 2" fill="#dcab82" />
      <path d="M-40-177c12-24 67-24 81 2l-1 38c-2 30-18 47-40 47s-39-18-40-47Z" fill="#e9b98f" />
      {restaurant ? <><path d="M-43-154c-12-29 4-57 23-52 14-18 48-7 57 6 20 7 23 32 7 54-1-18-9-30-19-36-15 13-35 14-57 6Z" fill="#453b31" /><path d="M-34-186q11-24 30-16m-3 2q20-14 37 6" fill="none" stroke="#75614a" strokeWidth="3" strokeLinecap="round" /></> : candy ? <><path d="M-43-150c-8-33 4-57 29-59 33-10 65 11 58 58-6-12-16-23-21-38-17 18-34 24-66 39Z" fill="#4d4035" /><path d="M-29-192q27-25 52-5" fill="none" stroke="#83664e" strokeWidth="3" strokeLinecap="round" /><circle cx="-42" cy="-129" r="3.8" fill="#ba9250" /><circle cx="43" cy="-129" r="3.8" fill="#ba9250" /></> : <><path d="M-43-153c-13-38 12-66 37-58 32-11 63 22 50 59-6-19-17-33-36-40-12 20-30 24-51 39Z" fill="#3d4439" /><path d="M-32-184q15-27 39-16" stroke="#6d7660" strokeWidth="3" fill="none" strokeLinecap="round" /><path d="M-47-166q-8 15 0 27" stroke="#8fa17c" strokeWidth="4" fill="none" /></>}
      <path d="M-29-147q7-4 14-1m31 0q7-4 14 1" stroke="#76543e" strokeWidth="2" fill="none" strokeLinecap="round" />
      <g className="bc-host-eyes" fill="none" stroke="#444535" strokeWidth="2.3" strokeLinecap="round">
        <path d={thinking || serving ? 'M-27-137q5 5 10 0m35 0q5 5 10 0' : 'M-27-137q5-4 10 0m35 0q5-4 10 0'} />
      </g>
      <path d="m0-137-3 13q3 4 7 0" stroke="#bf8562" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <ellipse cx="-25" cy="-122" rx="8" ry="4" fill="#d18b70" opacity=".5" /><ellipse cx="25" cy="-122" rx="8" ry="4" fill="#d18b70" opacity=".5" />
      {pose === 'speaking' ? <g className="bc-host-mouth"><ellipse cy="-110" rx="8" ry="6" fill="#8b543e" /><path d="M-5-113H5" stroke="#f8e7c7" strokeWidth="2" strokeLinecap="round" /></g> : thinking ? <path d="M-8-110q8 3 16 0" stroke="#a56b4f" strokeWidth="1.7" fill="none" strokeLinecap="round" /> : <path d="M-12-113q12 13 25 0" fill="#f9eace" stroke="#b77f5d" strokeWidth="1.5" strokeLinecap="round" />}
    </g>
  </g>
}

function RestaurantRoom({ id, pose, dish, completed }: { id: string; pose: ScenePose; dish?: string | null; completed: boolean }) {
  return <>
    <rect width="1100" height="580" fill={`url(#${id}-wall)`} />
    <rect y="0" width="1100" height="44" fill="#624b35" /><path d="M0 39h1100M125 0v395M975 0v395" stroke="#a7774c" strokeWidth="14" /><path d="M0 50h1100" stroke="#c39a64" strokeWidth="4" />
    <g>
      <rect x="162" y="73" width="330" height="261" rx="4" fill="#8c6a47" /><rect x="177" y="87" width="300" height="230" fill="#e7ddb7" /><path d="M180 275q79-122 170-64t125-77v183H180Z" fill="#a9b493" opacity=".65" /><rect x="177" y="87" width="300" height="230" fill={`url(#${id}-lattice)`} opacity=".9" /><path d="M326 80v244M169 198h315" stroke="#8e6743" strokeWidth="9" />
      <rect x="777" y="81" width="139" height="206" fill="#ccb78b" stroke="#795c40" strokeWidth="7" /><rect x="789" y="93" width="115" height="182" fill="#eae1c3" />
      <path d="M845 255c0-50 14-73 7-132m-6 84-20-25m25-14 26-27m-31 81-20 15" stroke="#7e865d" strokeWidth="3" fill="none" /><path d="M827 185q-27-4-22-19 19 1 22 19m50-45q16-18 25-11-5 17-25 11m-28 13q-18-11-13-23 18 7 13 23m-24 81q-17-5-16-17 15 0 16 17" fill="#9aa077" /><circle cx="854" cy="119" r="11" fill="#be785c" opacity=".6" />
    </g>
    <ellipse cx="627" cy="180" rx="235" ry="190" fill={`url(#${id}-light)`} />
    <g transform="translate(645 62)"><path d="M0-62v42" stroke="#68503c" strokeWidth="3" /><path d="M-54-19H54L70 40q-70 21-140 0Z" fill="#ead39b" stroke="#9c7b48" strokeWidth="2" /><path d="m-41-18-10 63m31-63-6 68m46-68 6 68m15-68 10 63" stroke="#c1a064" strokeWidth="2" /><path d="M-70 40h140" stroke="#9a7845" strokeWidth="4" /></g>
    <g transform="translate(83 315)"><path d="M-30 0q-9 43 5 61h51q13-20 3-61Z" fill="#718069" /><ellipse rx="31" ry="8" fill="#a5ad86" /><path d="M0-3q-29-61-12-112m10 111q11-75 51-104M-2-21q-36-8-56-44" stroke="#7c7f58" strokeWidth="3" fill="none" /><path d="M-15-101q-26-37-39-23 3 23 39 23m42 24q-1-34 25-36 7 21-25 36m-44 42q-37-30-46-12 20 20 46 12m31-19q7-41-13-45-13 25 13 45" fill="#8d9c74" /></g>
    <path d="M142 324h806v64H142Z" fill="#9c704c" /><path d="M136 320h818v9H136Z" fill="#c8a373" />
    <g transform="translate(647 336)"><Host station="restaurant" pose={pose} /></g>
    <path d="M201 349h698l173 173H28Z" fill="#a36b48" stroke="#7c5037" strokeWidth="3" /><path d="M28 522h1044v58H28Z" fill="#805039" /><path d="M32 524h1036v9H32Z" fill="#c39460" /><path d="M233 352h634l109 145H115Z" fill="#d3b78e" /><path d="M279 352h74l-25 145H214Zm468 0h74l65 145h-114Z" fill="#b88d66" opacity=".55" />
    <g transform="translate(307 422) rotate(-10)"><path d="M-78-64 40-68l20 116-123 5Z" fill="#6d8063" stroke="#52624c" strokeWidth="2" /><path d="m-67-58 99-3 18 102-104 4Z" fill="#f3e5c5" /><path d="M-57-45h74M-54-38h62" stroke="#ac8e59" strokeWidth="2" />{dishes.map((kind,i) => <g key={kind} transform={`translate(-55 ${-28+i*23}) scale(.25)`}><DishContent dish={kind} /></g>)}<path d="m5-6 20-1M8 17l21-1m-17 25 20-1" stroke="#baaa7e" strokeWidth="2.5" /></g>
    <g transform={completed ? 'translate(453 360) scale(1.45)' : 'translate(485 392) scale(1.12)'} className={completed ? 'bc-delivered-dish' : undefined}>{dish && dishes.includes(dish as typeof dishes[number]) ? <DishContent dish={dish} /> : <Plate />}</g>
    {completed && <Steam x={614} y={413} scale={1.1} />}
    <TeaCup x={820} y={400} scale={.8} />
    <path d="m784 461 96-48m-90 58 98-48" stroke="#6f4f33" strokeWidth="5" strokeLinecap="round" /><path d="m782 462 30-15m-24 24 30-15" stroke="#c7a275" strokeWidth="3" strokeLinecap="round" />
  </>
}

function CandyShop({ id, pose, flavor, completed }: { id: string; pose: ScenePose; flavor?: string | null; completed: boolean }) {
  return <>
    <rect width="1100" height="580" fill="#efdfc3" />
    <path d="M0 0h1100v59H0Z" fill="#6a5540" /><path d="M0 48h1100v11H0Z" fill="#b48b5d" /><path d="M79 0v364m944-364v364" stroke="#916b47" strokeWidth="18" /><path d="M90 0v364m922-364v364" stroke="#c3a175" strokeWidth="3" />
    <g>
      {[{x:135,w:251},{x:714,w:251}].map(({x,w}) => <g key={x}>
        <rect x={x} y="91" width={w} height="265" rx="3" fill="#9b7850" stroke="#75553b" strokeWidth="6" />
        <rect x={x+12} y="102" width={w-24} height="242" fill="#c5a378" />
        {[128, 207].map((y) => <g key={y}>{[0,1,2].map((i) => <g key={i} transform={`translate(${x+47+i*77} ${y})`}><path d="M-23 1q-6 17-4 52 28 14 55 0 2-35-5-52Z" fill="#e3c99b" stroke="#9e8057" strokeWidth="1.5" /><ellipse cy="1" rx="24" ry="7" fill="#d9be8d" stroke="#a08358" /><path d="M-24-2h48v8h-48Z" fill={['#9a6754','#b3945d','#65816a'][i]} /><rect x="-13" y="20" width="26" height="22" rx="7" fill="#f4e6c6" /><path d="M-6 26h12m-12 5h12m-9 5h6" stroke="#ac9469" strokeWidth="1.4" /><path d="M-23 48q24 9 47 0" stroke="#bd9d6e" fill="none" /></g>)}<rect x={x+3} y={y+61} width={w-6} height="9" fill="#7f593c" /><path d={`M${x+3} ${y+62}h${w-6}`} stroke="#d2ad77" strokeWidth="2" /></g>)}
        {[0,1,2].map((i) => <g key={i}><rect x={x+8+i*79} y="288" width="76" height="54" fill="#ae8859" stroke="#76563a" strokeWidth="2" /><rect x={x+29+i*79} y="303" width="35" height="13" rx="3" fill="#cfb785" /><path d={`M${x+40+i*79} 322h13`} stroke="#715535" strokeWidth="3" strokeLinecap="round" /></g>)}
      </g>)}
    </g>
    <path d="M430 73h240v66H430Z" fill="#897347" stroke="#c4aa71" strokeWidth="4" /><path d="M439 82h222v48H439Z" fill="#e5d6b0" />
    <g transform="translate(550 111)" stroke="#8f865b" fill="none" strokeWidth="2"><path d="M-18 2q-9-19 8-24 7-18 20-9 15 2 10 16 13 17-3 23-22 12-35-6Z" fill="#c8bd87" /><path d="M0-25q6-12 17-11M-9-8q11-6 22-1" /><path d="M-83-6h42M-83 2h30m94-8h42m-30 8h30" stroke="#a69c71" /></g>
    <ellipse cx="548" cy="226" rx="194" ry="150" fill={`url(#${id}-light)`} />
    <g transform="translate(550 349)"><Host station="candy" pose={pose} /></g>
    <path d="M68 345h964l39 50H30Z" fill="#c5a375" stroke="#8b6947" strokeWidth="3" /><path d="M30 395h1041v185H30Z" fill={`url(#${id}-wood)`} />
    <path d="M61 413h978v132H61Z" fill="#d9cfaa" stroke="#745638" strokeWidth="8" /><rect x="70" y="422" width="960" height="114" fill={`url(#${id}-glass)`} />
    <path d="M76 432h946v92H76Z" fill={`url(#${id}-shelf-pattern)`} />
    {[0,1,2,3,4,5,6,7,8,9,10,11].map(i => <g key={i} transform={`translate(${108+i*79} 473)`}><path d="m-25-12 21-7 26 9-2 22-25 7-23-9Z" fill={i%3===0?'#d4a879':i%3===1?'#d9bd87':'#bfa67b'} stroke="#a18a60" strokeWidth="1" /><path d="m-25-12 22 8 25-6m-25 6 0 23" fill="none" stroke="#e6cda4" strokeWidth="1.5" /><path d="m-9-13 10 4 0 21" stroke="#8f7855" strokeWidth="4" /></g>)}
    <path d="m112 424 104 110m136-110 104 110m136-110 104 110m136-110 104 110" stroke="#fff9e4" strokeWidth="14" opacity=".15" /><path d="M378 417v121m344-121v121" stroke="#96754d" strokeWidth="8" />
    <path d="M23 388h1055v15H23Z" fill="#805a3a" /><path d="M23 388h1055v4H23Z" fill="#dbbe8c" />
    {flavors.map((kind,i) => <g key={kind} transform={`translate(${completed ? 210+i*124 : 308+i*163} 271) scale(${completed ? .65 : .85})`}><CandyPacket flavor={kind} /></g>)}
    {completed && flavor && flavors.includes(flavor as typeof flavors[number]) && <g className="bc-candy-delivery">
      <g transform="translate(686 299)"><path d="M-63 4q63-11 126 0l-8 100H-56Z" fill="#ddc79a" stroke="#9a8052" strokeWidth="2" /><path d="M-32 7v-27c0-34 64-34 64 0V7" stroke="#a88a54" strokeWidth="7" fill="none" /><path d="M-31 8v-28c0-31 62-31 62 0V8" stroke="#ead8ac" strokeWidth="2" fill="none" /><path d="m-62 5 13 18-7 80m119-98-14 18 6 80" stroke="#bfa573" fill="none" strokeWidth="1.5" /></g>
      <g className="bc-candy-pack-one" transform="translate(606 280) scale(.65)"><CandyPacket flavor={flavor} /></g><g className="bc-candy-pack-two" transform="translate(677 290) scale(.65)"><CandyPacket flavor={flavor} /></g>
    </g>}
  </>
}

function TeahouseRoom({ id, pose, completed }: { id: string; pose: ScenePose; completed: boolean }) {
  return <>
    <rect width="1100" height="580" fill="#e4e6d6" />
    <rect x="125" y="41" width="850" height="342" fill="#907a55" /><rect x="141" y="57" width="818" height="311" fill={`url(#${id}-sky)`} />
    <circle cx="774" cy="124" r="42" fill="#f3e9c9" opacity=".7" />
    <path d="M141 237q64-21 98-53t67 7q56-63 112-11t111 10q70-74 119-29t78 11q45-57 97-18t136 18v121H141Z" fill="#b7c7ad" />
    <path d="M141 264q86-18 135-12t107-22q47-34 100 2t98 3q74-51 126-11t116-4q70-49 136 6v82H141Z" fill="#91af99" />
    <rect x="141" y="283" width="818" height="85" fill={`url(#${id}-water)`} />
    <g className="bc-water-ripples" fill="none" stroke="#d6e0c4" strokeWidth="2" strokeLinecap="round" opacity=".65"><path d="M169 306h74m26 12h40m-106 19h99m44-34h67m320 12h88m-58 28h88m-174-7h49m-372 14h52m492-48h42" /></g>
    <g transform="translate(829 256)"><path d="M-91 28h166v8H-91Z" fill="#747962" /><path d="M-68 24v-75h119v75" fill="#bbba91" stroke="#6d7a60" strokeWidth="5" /><path d="M-45-47v68M-10-47v68M26-47v68" stroke="#7c8969" strokeWidth="5" /><path d="M-97-46q23 0 37-17l48-37 52 37q14 17 38 17l-8 10H-87Z" fill="#4f7060" stroke="#3f6251" strokeWidth="2" /><path d="M-92-45q35-8 79-47 45 38 84 47M-11-91v50M-37-76-47-42M15-77l13 35" fill="none" stroke="#839a7c" strokeWidth="2" /><path d="M-73-11H56M-73 13H56" stroke="#8d9672" strokeWidth="4" /></g>
    <path d="M144 57h814v13H144Zm0 287h814v24H144Z" fill="#7d684a" /><path d="M141 204h818M350 57v311M748 57v311" stroke="#8d7752" strokeWidth="14" /><path d="M141 207h818M353 57v311M751 57v311" stroke="#bead80" strokeWidth="3" />
    <path d="M141 72h209v116H141Zm608 0h210v116H749Z" fill={`url(#${id}-lattice)`} opacity=".75" />
    <path d="M115 33v356M985 33v356" stroke="#685d43" strokeWidth="20" /><path d="M121 36v350M979 36v350" stroke="#b39b6f" strokeWidth="4" />
    <path d="M109 379h882v15H109Z" fill="#9b845b" /><path d="M0 0h1100v25H0Z" fill="#716347" /><path d="M0 27h1100" stroke="#b6a475" strokeWidth="5" />
    <g transform="translate(207 335)"><path d="M-26 11q-12-23-3-52H28Q40-8 27 11Z" fill="#7b967c" stroke="#536d59" strokeWidth="2" /><ellipse cy="-43" rx="29" ry="8" fill="#b1bd98" /><path d="M-5-47Q-28-85-8-126m8 81Q35-80 27-125M-8-79l-33-29m45 22 32-14" stroke="#677e58" fill="none" strokeWidth="2.5" /><path d="M-8-117q-21-16-10-29 17 5 10 29m34 1q14-23 26-14-1 19-26 14m-56 19q-28-1-25-17 18-6 25 17m63-2q20-17 32-6-12 18-32 6m-22 35q-20-25-11-34 22 9 11 34" fill="#839a71" /></g>
    <g transform="translate(560 345)"><Host station="teahouse" pose={pose} /></g>
    <path d="M156 364h788l156 171H0Z" fill="#b6a078" stroke="#7e6e50" strokeWidth="3" /><path d="M0 535h1100v45H0Z" fill="#806c4d" /><path d="M0 534h1100v6H0Z" fill="#c8b48a" />
    <path d="M333 366h419l77 165H254Z" fill="#d9ddc6" /><path d="M350 366 275 530m460-164 71 164" stroke="#a9b59b" strokeWidth="3" /><path d="M316 478h458M306 498h478M297 518h497" stroke="#a5b299" strokeWidth="1.4" opacity=".6" />
    <ellipse cx="563" cy="434" rx="174" ry="52" fill="#667b60" opacity=".15" /><path d="M410 403q151-31 306 0l25 45q-175 47-356 0Z" fill="#99784e" stroke="#776343" strokeWidth="2" /><path d="M418 408q148-26 291 0l14 32q-160 39-321 0Z" fill="#b79d6c" stroke="#d6be86" strokeWidth="2" />
    <g className={pose === 'welcome' ? 'bc-teapot bc-teapot-pouring' : 'bc-teapot'} transform="translate(629 382) scale(.92)"><TeaPot /></g>
    {pose === 'welcome' && <path className="bc-pour-stream" d="M543 367q-7 17-14 33" stroke="#c0b471" strokeWidth="3" fill="none" strokeLinecap="round" />}
    <TeaCup x={510} y={414} scale={1.05} /><Steam x={510} y={395} scale={.85} /><TeaCup x={382} y={468} scale={.88} />
    <g transform="translate(782 469)"><ellipse rx="47" ry="15" fill="#e1e3c9" stroke="#8da18a" strokeWidth="1.5" />{[-20,0,20].map((x,i) => <g key={x} transform={`translate(${x} ${i%2?-4:0})`}><path d="M-12-9q12-10 24 0l-2 15q-10 7-20 0Z" fill="#d0b775" stroke="#ae945d" strokeWidth="1" /><path d="m-6-6 13 1m-14 5 14 1" stroke="#f2dba4" strokeWidth="1.5" /></g>)}</g>
    {completed && <g className="bc-tea-thanks" transform="translate(920 427)" fill="none" stroke="#b49a5e" strokeWidth="2"><path d="M-17 0q17-26 34 0-17 26-34 0Z" /><path d="M0-17v34m-22-17h44" /><circle r="8" /></g>}
  </>
}

/** Presentation only. The parent sets completed after a successful server save. */
export function StationScene({ station, pose = 'welcome', selectedDish, selectedFlavor, completed = false, label, className }: StationSceneProps) {
  const id = `station-${station}-${useId().replace(/:/g, '')}`
  const resolvedPose = completed && pose !== 'packing' ? 'packed' : pose
  const fallbackLabels = {
    restaurant: 'A server welcomes you to a warm dining room with a menu and a porcelain place setting.',
    candy: 'A shopkeeper behind a glass candy counter, with rose, osmanthus and mint packages displayed equally.',
    teahouse: 'A tea host at a quiet table, with celadon cups and a window overlooking a garden pond.',
  }
  return <svg className={`bc-station-scene bc-${station}-scene${className ? ` ${className}` : ''}`} data-pose={resolvedPose} data-completed={completed} viewBox="0 0 1100 580" preserveAspectRatio="xMidYMid slice" role="img" aria-labelledby={`${id}-title`} focusable="false">
    <title id={`${id}-title`}>{label || fallbackLabels[station]}</title><SceneDefs id={id} />
    {station === 'restaurant' ? <RestaurantRoom id={id} pose={resolvedPose} dish={selectedDish} completed={completed} /> : station === 'candy' ? <CandyShop id={id} pose={resolvedPose} flavor={selectedFlavor} completed={completed} /> : <TeahouseRoom id={id} pose={resolvedPose} completed={completed} />}
    <rect width="1100" height="580" fill={`url(#${id}-grain)`} pointerEvents="none" />
  </svg>
}
