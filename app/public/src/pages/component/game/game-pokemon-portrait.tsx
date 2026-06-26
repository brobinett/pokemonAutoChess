import type React from "react"
import { useEffect, useMemo, useState } from "react"
import { Tooltip } from "react-tooltip"
import { RarityColor } from "../../../../../config"
import { EvolutionManager } from "../../../../../core/evolution-logic/evolution-manager"
import type { Pokemon } from "../../../../../models/colyseus-models/pokemon"
import {
  getPkmWithCustom,
  type PokemonCustoms
} from "../../../../../models/colyseus-models/pokemon-customs"
import PokemonFactory from "../../../../../models/pokemon-factory"
import { getBuyPrice } from "../../../../../models/shop"
import { EvolutionRuleType } from "../../../../../types/EvolutionRules"
import { type Pkm, PkmFamily } from "../../../../../types/enum/Pokemon"
import { getPortraitSrc } from "../../../../../utils/avatar"
import { schemaValues } from "../../../../../utils/schemas"
import {
  selectConnectedPlayer,
  selectSpectatedPlayer,
  useAppSelector
} from "../../../hooks"
import { getGameScene } from "../../game"
import { cc } from "../../utils/jsx"
import { Money } from "../icons/money"
import SynergyIcon from "../icons/synergy-icon"
import { GamePokemonDetail } from "./game-pokemon-detail"
import "./game-pokemon-portrait.css"

// scene.textures.getBase64() serializes the portrait texture's canvas to a data URL via the synchronous
// canvas.toDataURL() — an expensive readback. This function is called from every portrait render (shop,
// bench, board tooltips, synergy panels, propositions…), and those components re-render on every board/
// player state change, so on a busy board it was re-encoding the same portraits many times a second
// (the dominant main-thread JS cost during combat — surfaced by profiling the replay viewer). The base64
// of `portrait-${index}` is stable WITHIN a game, so cache it once per index. It is NOT globally constant:
// preloadPortraits bakes the POV player's shiny/emotion customs into the texture, and the TextureManager
// is destroyed on game teardown — so the cache must be dropped at that boundary (clearPortraitBase64Cache),
// else a later game/recording with different customs for the same species shows the previous sprite. The
// key is the texture key (index only, matching getBase64's own key); customs only feed the pre-load URL
// fallback. Only the real base64 is cached — if the texture isn't loaded yet we return the URL fallback
// WITHOUT caching, so a later render (once the texture exists) still gets to cache the base64.
const portraitBase64Cache = new Map<string, string>()
export function getCachedPortrait(
  index: string,
  customs?: PokemonCustoms
): string {
  const cached = portraitBase64Cache.get(index)
  if (cached !== undefined) return cached
  // Only read back a texture that's actually loaded. getBase64 returns "" (empty string) for an absent
  // key — the prior `getBase64(...) ?? getPortraitSrc(...)` used ??, which doesn't catch "", so it
  // returned a broken url("") until the texture loaded. Gating on exists() both avoids a wasted toDataURL
  // and fixes that: when the texture isn't present we fall back to the portrait URL (which honours the
  // shiny/emotion customs, unlike the index-keyed texture) and do NOT cache the fallback, so a later
  // render once the texture loads still caches the real portrait.
  const scene = getGameScene()
  if (scene?.textures.exists(`portrait-${index}`)) {
    const base64 = scene.textures.getBase64(`portrait-${index}`)
    portraitBase64Cache.set(index, base64)
    return base64
  }
  const pokemonCustom = getPkmWithCustom(index, customs)
  return getPortraitSrc(index, pokemonCustom.shiny, pokemonCustom.emotion)
}

/** Drop every cached portrait base64. The cache mirrors the lifetime of the `portrait-${index}` textures,
 * which bake the POV player's customs and are destroyed with the Phaser TextureManager on game teardown.
 * Call this at each such boundary (live leave, /replay route unmount, loading a new recording) so a later
 * game/recording with different shiny/emotion for the same species can't show the previous one's sprite. */
export function clearPortraitBase64Cache() {
  portraitBase64Cache.clear()
}

export default function GamePokemonPortrait(props: {
  index: number
  origin: "wiki" | "shop" | "proposition" | "team" | "planner" | "battle"
  pokemon: Pokemon | Pkm | undefined
  click?: React.MouseEventHandler<HTMLDivElement>
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>
  inPlanner?: boolean
}) {
  const pokemon = useMemo(() => {
    if (typeof props.pokemon === "string") {
      const pokemon = PokemonFactory.createPokemonFromName(props.pokemon)
      pokemon.pp = pokemon.maxPP
      return pokemon
    }
    return props.pokemon
  }, [props.pokemon])

  const currentPlayerUid: string = useAppSelector((state) => state.network.uid)
  const spectatedPlayerId: string = useAppSelector(
    (state) => state.game.playerIdSpectated
  )
  const spectatedPlayer = useAppSelector(selectSpectatedPlayer)
  const connectedPlayer = useAppSelector(selectConnectedPlayer)

  const board = connectedPlayer?.board ?? null

  const specialGameRule = useAppSelector((state) => state.game.specialGameRule)
  const stageLevel = useAppSelector((state) => state.game.stageLevel)

  const isOnAnotherBoard = spectatedPlayerId !== currentPlayerUid

  const [count, setCount] = useState(0)
  const [countEvol, setCountEvol] = useState(0)

  // recount where board size or pokemon on this shop cell changes
  useEffect(() => {
    let _count = 0
    let _countEvol = 0
    if (
      board &&
      board.forEach &&
      !isOnAnotherBoard &&
      props.pokemon &&
      pokemon &&
      pokemon.hasEvolution
    ) {
      board.forEach((p) => {
        if (p.name === pokemon.name) {
          _count++
        } else if (PkmFamily[p.name] === pokemon.name) {
          _countEvol++
        }
      })
    }

    setCount(_count)
    setCountEvol(_countEvol)
  }, [board, board?.size, props.pokemon, pokemon, isOnAnotherBoard])

  if (!props.pokemon || !pokemon) {
    return <div className="game-pokemon-portrait my-box empty" />
  }

  const customs = spectatedPlayer?.pokemonCustoms
  const pokemonCustom = getPkmWithCustom(pokemon.index, customs)
  const rarityColor = RarityColor[pokemon.rarity]

  const evolutionName = spectatedPlayer
    ? EvolutionManager.getEvolution(pokemon, spectatedPlayer)
    : (pokemon.evolutions[0] ?? pokemon.evolution)
  let pokemonEvolution = PokemonFactory.createPokemonFromName(evolutionName)

  const willEvolve =
    pokemon.evolutionRule.type === EvolutionRuleType.COUNT &&
    count === pokemon.evolutionRule.numberRequired - 1

  const shouldShimmer =
    pokemon.evolutionRule.type === EvolutionRuleType.COUNT &&
    ((count > 0 && pokemon.hasEvolution) ||
      (countEvol > 0 && pokemonEvolution.hasEvolution))

  if (
    pokemon.evolutionRule.type === EvolutionRuleType.COUNT &&
    count === pokemon.evolutionRule.numberRequired - 1 &&
    countEvol === pokemon.evolutionRule.numberRequired - 1 &&
    pokemonEvolution.hasEvolution
  ) {
    const evolutionName2 = spectatedPlayer
      ? EvolutionManager.getEvolution(
          pokemonEvolution,
          spectatedPlayer,
          stageLevel
        )
      : (pokemonEvolution.evolutions[0] ?? pokemonEvolution.evolution)
    pokemonEvolution = PokemonFactory.createPokemonFromName(evolutionName2)
  }

  const pokemonInPortrait =
    willEvolve && pokemonEvolution ? pokemonEvolution : pokemon

  const cost = getBuyPrice(pokemon.name, specialGameRule)

  const gainedSynergies =
    pokemonEvolution && willEvolve
      ? schemaValues(pokemonEvolution.types).filter(
          (type) => !pokemon.types.has(type)
        )
      : []
  const lostSynergies =
    pokemonEvolution && willEvolve
      ? schemaValues(pokemon.types).filter(
          (type) => !pokemonEvolution.types.has(type)
        )
      : []

  const canBuy = spectatedPlayer?.alive && spectatedPlayer?.money >= cost

  return (
    <div
      className={cc("my-box", "clickable", "game-pokemon-portrait", {
        shimmer: shouldShimmer,
        disabled: !canBuy && props.origin === "shop",
        planned: props.inPlanner ?? false
      })}
      style={{
        backgroundColor: rarityColor,
        borderColor: rarityColor,
        backgroundImage: `url("${getCachedPortrait(pokemonInPortrait.index, customs)}")`
      }}
      onClick={(e) => {
        if (canBuy && props.click) props.click(e)
      }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      data-tooltip-id={`tooltip-${props.origin}-${props.index}`}
    >
      <Tooltip
        id={`tooltip-${props.origin}-${props.index}`}
        className="custom-theme-tooltip game-pokemon-detail-tooltip"
        place="top"
      >
        <GamePokemonDetail
          key={pokemonInPortrait.id}
          pokemon={pokemonInPortrait}
          emotion={pokemonCustom.emotion}
          shiny={pokemonCustom.shiny}
          origin={props.origin}
        />
      </Tooltip>
      {willEvolve && pokemonEvolution && (
        <div className="game-pokemon-portrait-evolution">
          <img
            src={getCachedPortrait(pokemon.index, customs)}
            className="game-pokemon-portrait-evolution-portrait"
          />
          <img
            src="/assets/ui/evolution.png"
            alt=""
            className="game-pokemon-portrait-evolution-icon"
          />
        </div>
      )}
      {props.inPlanner && (!willEvolve || !pokemonEvolution) && (
        <img
          src="/assets/ui/planned.png"
          alt=""
          className="game-pokemon-portrait-planned-icon"
        />
      )}
      {props.origin === "shop" && (
        <div className="game-pokemon-portrait-cost">
          <Money value={cost} />
        </div>
      )}
      <ul className="game-pokemon-portrait-types">
        {Array.from(pokemonInPortrait.types.values()).map((type) => {
          return (
            <li
              key={type}
              className={cc({ gained: gainedSynergies.includes(type) })}
            >
              <SynergyIcon type={type} />
            </li>
          )
        })}
        {lostSynergies.map((type) => (
          <li key={type} className="lost">
            <SynergyIcon type={type} />
          </li>
        ))}
      </ul>
    </div>
  )
}
