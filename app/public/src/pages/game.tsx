import { getStateCallbacks, type Room } from "@colyseus/sdk"
import firebase from "firebase/compat/app"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"
import { toast } from "react-toastify"
import {
  getCurrentGameEvent,
  MinStageForGameToCount,
  RegionDetails
} from "../../../config"
import type { IPokemonRecord } from "../../../models/colyseus-models/game-record"
import type { Wanderer } from "../../../models/colyseus-models/wanderer"
import { PVEStages } from "../../../models/pve-stages"
import type AfterGameState from "../../../rooms/states/after-game-state"
import type GameState from "../../../rooms/states/game-state"
import {
  type IAfterGamePlayer,
  type IBoardEvent,
  type IDps,
  type IDragDropCombineMessage,
  type IDragDropItemMessage,
  type IDragDropMessage,
  type IExperienceManager,
  type IPlayer,
  Role,
  Transfer
} from "../../../types"
import { CloseCodes, CloseCodesMessages } from "../../../types/enum/CloseCodes"
import { ConnectionStatus } from "../../../types/enum/ConnectionStatus"
import { GamePhaseState, Team } from "../../../types/enum/Game"
import type { Item } from "../../../types/enum/Item"
import { Passive } from "../../../types/enum/Passive"
import type { Pkm } from "../../../types/enum/Pokemon"
import type { Synergy } from "../../../types/enum/Synergy"
import { GameEvent } from "../../../types/events"
import type { NonFunctionPropNames } from "../../../types/HelperTypes"
import type { DisplayText } from "../../../types/strings/DisplayText"
import type { ErrorMessage } from "../../../types/strings/ErrorMessage"
import { getAvatarString } from "../../../utils/avatar"
import { logger } from "../../../utils/logger"
import { schemaValues } from "../../../utils/schemas"
import GameContainer from "../game/game-container"
import type GameScene from "../game/scenes/game-scene"
import {
  selectConnectedPlayer,
  selectSpectatedPlayer,
  useAppDispatch,
  useAppSelector
} from "../hooks"
import { authenticateUser, client, joinGame, rooms } from "../network"
import store from "../stores"
import {
  addDpsMeter,
  addPlayer,
  changeDpsMeter,
  changePlayer,
  changeShop,
  leaveGame,
  removeDpsMeter,
  removePlayer,
  setAdditionalPokemons,
  setEmotesUnlocked,
  setGameMode,
  setInterest,
  setLife,
  setLoadingProgress,
  setMaxInterest,
  setMoney,
  setNoELO,
  setPhase,
  setPodium,
  setRoundTime,
  setShopFreeRolls,
  setShopLocked,
  setSpecialGameRule,
  setStageLevel,
  setStreak,
  setSynergies,
  setWeather,
  updateExperienceManager
} from "../stores/GameStore"
import {
  setConnectionStatus,
  setErrorAlertMessage
} from "../stores/NetworkStore"
import GameChoice from "./component/game/game-choice"
import GameDpsMeter from "./component/game/game-dps-meter"
import GameExpeditions from "./component/game/game-expeditions"
import GameFinalRank from "./component/game/game-final-rank"
import GameLoadingScreen from "./component/game/game-loading-screen"
import GamePlayers from "./component/game/game-players"
import GameShop from "./component/game/game-shop"
import GameSpectatePlayerInfo from "./component/game/game-spectate-player-info"
import GameStageInfo from "./component/game/game-stage-info"
import GameSynergies from "./component/game/game-synergies"
import GameToasts from "./component/game/game-toasts"
import { clearPortraitBase64Cache } from "./component/game/game-pokemon-portrait"
import { MainSidebar } from "./component/main-sidebar/main-sidebar"
import { ConnectionStatusNotification } from "./component/system/connection-status-notification"
import { playMusic, preloadMusic } from "./utils/audio"
import { LocalStoreKeys, localStore } from "./utils/store"
import { transformEntityCoordinates } from "./utils/utils"

let gameContainer: GameContainer

// Replay-only re-attach hook. The game page installs an implementation in its init effect; the replay
// viewer calls reattachReplayRoom() on a seek to swap the live GameContainer onto a fresh ReplayRoom
// WITHOUT tearing down Phaser (keeping the loaded assets, so a seek is near-instant). It is (re)installed
// on every game-page mount (overwriting any earlier closure) and intentionally NOT cleared on unmount:
// the install is guarded to run once per instance, so a per-unmount null-out would, under StrictMode's
// setup→cleanup→setup, leave it permanently null. A stale impl after unmount is harmless — only the
// replay viewer calls reattachReplayRoom, and only while it's mounted.
let reattachReplayRoomImpl:
  | ((room: Room<GameState>, spectatedPlayerId?: string) => void)
  | null = null
export function reattachReplayRoom(
  room: Room<GameState>,
  spectatedPlayerId?: string
) {
  reattachReplayRoomImpl?.(room, spectatedPlayerId)
}

export function getGameScene(): GameScene | undefined {
  return gameContainer?.game?.scene?.getScene<GameScene>("gameScene") as
    | GameScene
    | undefined
}

export function getGameContainer(): GameContainer {
  return gameContainer
}

export function cyclePlayers(amt: number) {
  const players = schemaValues(gameContainer.room?.state.players)
  playerClick(
    players[
      (players.findIndex((p) => p === gameContainer.player) +
        amt +
        players.length) %
        players.length
    ].id
  )
}

export function playerClick(id: string) {
  const scene = getGameScene()
  gameContainer?.room?.send(Transfer.SPECTATE, id)
  if (scene?.spectate) {
    if (gameContainer?.room?.state?.players) {
      const spectatedPlayer = gameContainer?.room?.state?.players.get(id)
      if (spectatedPlayer) {
        gameContainer.setPlayer(spectatedPlayer)

        const simulation = gameContainer?.room?.state.simulations.get(
          spectatedPlayer.simulationId
        )
        if (simulation) {
          gameContainer.setSimulation(simulation)
        }
      }

      gameContainer?.gameScene?.board?.updateScoutingAvatars()
    }
  }
}

function showMoneyToast(value: number) {
  toast(
    <div className="toast-player-income">
      <span style={{ verticalAlign: "middle" }}>+{value}</span>
      <img className="icon-money" src="/assets/icons/money.svg" alt="$" />
    </div>,
    { containerId: "toast-money" }
  )
}

export default function Game() {
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const connectionStatus = useAppSelector(
    (state) => state.network.connectionStatus
  )
  const room: Room<GameState> | undefined = rooms.game
  const uid: string = useAppSelector((state) => state.network.uid)
  const spectatedPlayerId: string = useAppSelector(
    (state) => state.game.playerIdSpectated
  )
  const connectedPlayer = useAppSelector(selectConnectedPlayer)
  const spectatedPlayer = useAppSelector(selectSpectatedPlayer)
  const spectate = spectatedPlayerId !== uid || !spectatedPlayer?.alive

  const initialized = useRef<boolean>(false)
  const connecting = useRef<boolean>(false)
  const connected = useRef<boolean>(false)
  const [loaded, setLoaded] = useState<boolean>(false)
  const [connectError, setConnectError] = useState<string>("")
  const [finalRank, setFinalRank] = useState<number>(0)
  enum FinalRankVisibility {
    HIDDEN,
    VISIBLE,
    CLOSED
  }
  const [finalRankVisibility, setFinalRankVisibility] =
    useState<FinalRankVisibility>(FinalRankVisibility.HIDDEN)
  const container = useRef<HTMLDivElement>(null)

  const currentGameEvent = getCurrentGameEvent()

  const MAX_ATTEMPS_RECONNECT = 3

  const connectToGame = useCallback(
    async (attempts = 1) => {
      logger.debug(
        `connectToGame attempt ${attempts} / ${MAX_ATTEMPS_RECONNECT}`
      )
      const cachedReconnectionToken = localStore.get(
        LocalStoreKeys.RECONNECTION_GAME
      )?.reconnectionToken
      if (cachedReconnectionToken) {
        connecting.current = true
        const statusMessage = document.querySelector("#status-message")
        if (statusMessage) {
          statusMessage.textContent = `Connecting to game...`
        }

        client
          .reconnect<GameState>(cachedReconnectionToken)
          .then((room: Room) => {
            joinGame(room, 60 * 60) // once in game, reconnection token is valid for 1 hour
            connected.current = true
            connecting.current = false
            dispatch(setConnectionStatus(ConnectionStatus.CONNECTED))
          })
          .catch((error) => {
            if (attempts < MAX_ATTEMPS_RECONNECT) {
              setTimeout(async () => await connectToGame(attempts + 1), 1000)
            } else {
              let connectError = error.message
              if (error.code === 4212) {
                // room disposed
                connectError = "This game does no longer exists"
              }
              //TODO: handle more known error codes with informative messages
              setConnectError(connectError)
              dispatch(setConnectionStatus(ConnectionStatus.CONNECTION_FAILED))
              logger.error("reconnect error", error)
            }
          })
      } else {
        navigate("/") // no reconnection token, login again
      }
    },
    [client, dispatch]
  )

  const leave = useCallback(async () => {
    // A replay reuses this live <Game/>; its exit paths (browser Back, an end-of-match overlay button,
    // any future caller) must NOT run the live leave flow — it creates an after-game room on the REAL
    // server from the recorded match's players + this user's token. For a replay just return to the lobby;
    // the /replay route's own unmount tears down the Phaser game and the ReplayRoom. No-op for a live game
    // (a real Colyseus room id is never "replay").
    if ((room as { roomId?: string })?.roomId === "replay") {
      // The /replay route's own unmount teardown stops the current ReplayRoom's timer and restores state;
      // here we only need to leave the route (this `room` is the stale mount-time ReplayRoom anyway).
      navigate("/lobby")
      return
    }
    const afterPlayers = new Array<IAfterGamePlayer>()

    const token = await firebase.auth().currentUser?.getIdToken()

    if (gameContainer && gameContainer.game) {
      // The portrait textures bake this game's POV customs and die with the TextureManager here — drop
      // their base64 cache so the next game/recording can't show this one's cached sprites.
      clearPortraitBase64Cache()
      gameContainer.game.destroy(true)
    }

    const nbPlayers = room?.state.players.size ?? 0
    const hasLeftBeforeEnd =
      connectedPlayer?.alive === true && room?.state?.gameFinished === false

    if (nbPlayers > 0) {
      room?.state.players.forEach((p) => {
        const afterPlayer: IAfterGamePlayer = {
          elo: p.elo,
          games: p.games,
          name: p.name,
          id: p.id,
          rank: p.rank,
          avatar: p.avatar,
          title: p.title,
          role: p.role,
          pokemons: new Array<IPokemonRecord>(),
          synergies: new Array<{ name: Synergy; value: number }>(),
          gameStats: p.gameStats
        }

        const allSynergies = new Array<{ name: Synergy; value: number }>()
        p.synergies.forEach((v, k) => {
          allSynergies.push({ name: k as Synergy, value: v })
        })

        allSynergies.sort((a, b) => b.value - a.value)
        afterPlayer.synergies = allSynergies.slice(0, 5)

        if (p.board && p.board.size > 0) {
          p.board.forEach((pokemon) => {
            if (
              pokemon.positionY != 0 &&
              pokemon.passive !== Passive.INANIMATE
            ) {
              afterPlayer.pokemons.push({
                avatar: getAvatarString(
                  pokemon.index,
                  pokemon.shiny,
                  pokemon.emotion
                ),
                items: pokemon.items.toArray(),
                name: pokemon.name
              })
            }
          })
        }

        afterPlayers.push(afterPlayer)
      })
    }

    const eligibleToXP =
      nbPlayers >= 2 && (room?.state.stageLevel ?? 0) >= MinStageForGameToCount
    const eligibleToELO =
      nbPlayers >= 2 &&
      ((room?.state.stageLevel ?? 0) >= MinStageForGameToCount ||
        hasLeftBeforeEnd) &&
      !room?.state.noElo &&
      afterPlayers.filter((p) => p.role !== Role.BOT).length >= 2
    const gameMode = room?.state.gameMode

    const r = await client.create<AfterGameState>("after-game", {
      players: afterPlayers,
      idToken: token,
      eligibleToXP,
      eligibleToELO,
      gameMode
    })
    localStore.set(
      LocalStoreKeys.RECONNECTION_AFTER_GAME,
      { reconnectionToken: r.reconnectionToken, roomId: r.roomId },
      30
    )
    if (r.connection.isOpen) {
      await r.leave(false)
    }
    dispatch(leaveGame(0))
    navigate("/after")
    if (room?.connection.isOpen) {
      room.leave()
    }
  }, [client, dispatch, room])

  const spectateTillTheEnd = () => {
    setFinalRankVisibility(FinalRankVisibility.CLOSED)
    gameContainer.spectate = true
    if (gameContainer.gameScene) {
      gameContainer.gameScene.spectate = true
      // rerender to make items and units not dragable anymore
      gameContainer.gameScene?.board?.renderBoard(false)
      gameContainer.gameScene?.itemsContainer?.render(
        gameContainer.player!.items
      )
    }
  }

  useEffect(() => {
    // create a history entry to prevent back button switching page immediately, and leave game properly instead
    window.history.pushState(null, "", window.location.href)
    const confirmLeave = () => {
      if (confirm("Do you want to leave game ?")) {
        leave()
      } else {
        // push again another entry to prevent back button from switching page, effectively canceling the back action
        window.history.pushState(null, "", window.location.href)
      }
    }
    // when pressing back button, properly leave game
    window.addEventListener("popstate", confirmLeave)

    // pause video background for performance
    const videoBg = document.getElementById(
      "videobg"
    ) as HTMLVideoElement | null
    if (videoBg) {
      videoBg.pause()
      videoBg.style.display = "none"
    }

    return () => {
      if (videoBg) {
        videoBg.play()
        videoBg.style.display = "block"
      }
      window.removeEventListener("popstate", confirmLeave)
    }
  }, [])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        getGameScene()?.board?.clearBoard()
      } else {
        getGameScene()?.board?.renderBoard(false)
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    try {
      fetch("/leaderboards")
        .then((res) => res.json())
        .then((data) => {
          dispatch(setPodium(data.leaderboard.slice(0, 3)))
        })
    } catch (e) {
      console.error("error fetching leaderboard", e)
    }
  }, [])

  useEffect(() => {
    // Drop any portrait base64 cache left by a previous game/replay before this one bakes its own POV
    // customs — the normal-exit clear (leave / route unmount) misses abnormal exits (ROOM_DELETED /
    // USER_BANNED → back to lobby), so clear on entry too, making it exit-path-independent.
    clearPortraitBase64Cache()
    const connect = () => {
      logger.debug("connecting to game")
      authenticateUser().then(async (user) => {
        if (user && !connecting.current) {
          connecting.current = true
          await connectToGame()
        }
      })
    }

    if (rooms.game?.connection.isOpen) {
      connected.current = true
      dispatch(setConnectionStatus(ConnectionStatus.CONNECTED))
    }

    if (!connected.current) {
      connect()
    } else if (
      !initialized.current &&
      room != undefined &&
      container?.current
    ) {
      logger.debug("initializing game")
      initialized.current = true

      gameContainer = new GameContainer(container.current, uid, room)
      // A replay is always a spectate session. The GameScene keys "self" off
      // firebase.auth().currentUser (the real signed-in user), which for a replay is NOT the recorded
      // POV uid — so the spectate=false startGame would look up a player absent from the recording,
      // throw at setMap(undefined.map), and build no board/minigame/battle (black scene, no sprites).
      // Spectating from the first scene start makes startGame build from players[0] (then the POV's
      // spectatedPlayerId re-points to the recorded player), exactly as the seek/re-attach path does.
      // Detected via the ReplayRoom's fixed roomId so live games are untouched.
      if ((room as { roomId?: string }).roomId === "replay")
        gameContainer.spectate = true

      const gameElm = document.getElementById("game")
      gameElm?.addEventListener(Transfer.DRAG_DROP, ((
        event: CustomEvent<IDragDropMessage>
      ) => {
        gameContainer.onDragDrop(event)
      }) as EventListener)
      gameElm?.addEventListener(Transfer.DRAG_DROP_ITEM, ((
        event: CustomEvent<IDragDropItemMessage>
      ) => {
        gameContainer.onDragDropItem(event)
      }) as EventListener)
      gameElm?.addEventListener(Transfer.DRAG_DROP_COMBINE, ((
        event: CustomEvent<IDragDropCombineMessage>
      ) => {
        gameContainer.onDragDropCombine(event)
      }) as EventListener)

      // Per-room binding (inbound message handlers + state-change callbacks), extracted into a function
      // so the replay viewer can re-bind it to a fresh ReplayRoom on a seek without rebuilding Phaser
      // (reattachReplayRoomImpl below). For a live game it's called exactly once, with the same closure
      // values as before, so behaviour is unchanged. The `room` parameter intentionally shadows the
      // outer room: the body is byte-identical whether binding the initial room or a re-attached one.
      const bindRoom = (room: Room<GameState>) => {
        room.onMessage(Transfer.LOADING_COMPLETE, () => {
          setLoaded(true)
        })
        room.onMessage(Transfer.FINAL_RANK, (finalRank) => {
          setFinalRank(finalRank)
          // Suppress the placing popup in a replay: its live "stay till the end / leave game" actions
          // don't apply to a spectator, and it would otherwise sit over the rest of the match. The
          // placing still surfaces in the event log's FINAL_RANK row. No-op for a live game.
          if ((room as { roomId?: string }).roomId !== "replay")
            setFinalRankVisibility(FinalRankVisibility.VISIBLE)
        })
        room.onMessage(Transfer.PRELOAD_MAPS, async (maps) => {
          logger.info("preloading maps", maps)
          const gameScene = getGameScene()
          if (gameScene) {
            await gameScene.preloadMaps(maps)
            gameScene.load
              .once("complete", () => {
                if (room.state.phase !== GamePhaseState.TOWN) {
                  // map loaded after the end of the portal carousel stage, we swap it now. better later than never
                  gameContainer &&
                    gameContainer.player &&
                    gameScene.setMap(gameContainer.player.map)
                }
              })
              .start()
          }
        })
        room.onMessage(Transfer.SHOW_EMOTE, (message) => {
          const g = getGameScene()
          if (
            g?.minigameManager?.pokemons?.size &&
            g.minigameManager.pokemons.size > 0
          ) {
            // early return here to prevent showing animation twice
            return g.minigameManager?.showEmote(message.id, message?.emote)
          }

          if (g && g.board) {
            g.board.showEmote(message.id, message?.emote)
          }
        })
        room.onMessage(
          Transfer.COOK,
          async (message: { pokemonId: string; dishes: Item[] }) => {
            const g = getGameScene()
            if (g && g.board) {
              const pokemon = g.board.pokemons.get(message.pokemonId)
              if (pokemon) {
                pokemon.cookAnimation(message.dishes)
              }
            }
          }
        )

        room.onMessage(
          Transfer.DIG,
          async (message: { pokemonId: string; buriedItem: Item | null }) => {
            setTimeout(() => {
              const g = getGameScene()
              if (g && g.board) {
                const pokemon = g.board.pokemons.get(message.pokemonId)
                if (pokemon) {
                  pokemon.digAnimation(message.buriedItem)
                }
              }
            }, 500)
          }
        )

        room.onMessage(Transfer.POKEMON_DAMAGE, (message) => {
          gameContainer.handleDisplayDamage(message)
        })

        room.onMessage(Transfer.ABILITY, (message) => {
          gameContainer.handleDisplayAbility(message)
        })

        room.onMessage(Transfer.POKEMON_HEAL, (message) => {
          gameContainer.handleDisplayHeal(message)
        })

        room.onMessage(Transfer.PLAYER_DAMAGE, (value) => {
          toast(
            <div className="toast-player-damage">
              <span style={{ verticalAlign: "middle" }}>-{value}</span>
              <img className="icon-life" src="/assets/ui/heart.png" alt="❤" />
            </div>,
            { containerId: "toast-life" }
          )
        })

        room.onMessage(Transfer.PLAYER_INCOME, showMoneyToast)

        room.onMessage(Transfer.BOARD_EVENT, (event: IBoardEvent) => {
          if (gameContainer.game) {
            const g = getGameScene()
            if (g?.battle?.simulation?.id === event.simulationId) {
              g.battle.displayBoardEvent(event)
            }
          }
        })

        room.onMessage(Transfer.CLEAR_BOARD_EVENT, (event: IBoardEvent) => {
          //logger.debug("Received CLEAR_BOARD_EVENT", event)
          if (gameContainer.game) {
            const g = getGameScene()
            if (g?.battle?.simulation?.id === event.simulationId) {
              g.battle.removeBoardEvent(event)
            }
          }
        })

        room.onMessage(
          Transfer.CLEAR_BOARD,
          (event: { simulationId: string }) => {
            if (gameContainer.game) {
              const g = getGameScene()
              if (g?.battle?.simulation?.id === event.simulationId) {
                g.battle.clearBoardEvents()
              }
            }
          }
        )

        room.onMessage(Transfer.SIMULATION_STOP, () => {
          if (gameContainer.game) {
            const g = getGameScene()
            if (g && g.battle) {
              g.battle.clear()
            }
          }
        })

        room.onMessage(Transfer.GAME_END, () => {
          // In a replay, GAME_END is a recorded frame, not a live end-of-match signal: running the live
          // `leave` flow would destroy Phaser and fire a real client.create("after-game") against the
          // live server under the viewer's identity (→ the CONNECTION_FAILED screen finish() exists to
          // avoid). The ReplayRoom parks on its final frame via finish()/onEnded instead. Guard on the
          // fixed replay roomId so live games are untouched (mirrors the spectate guards above/below).
          if ((room as { roomId?: string }).roomId === "replay") return
          leave()
        })

        room.onMessage(Transfer.DRAG_DROP_CANCEL, (message) =>
          gameContainer.handleDragDropCancel(message)
        )

        room.onMessage(
          Transfer.DISPLAY_TEXT,
          (message: {
            text: DisplayText
            id: string
            x: number
            y: number
          }) => {
            const g = getGameScene()
            if (g?.battle?.simulation?.id === message.id && message.text) {
              const coordinates = transformEntityCoordinates(
                message.x,
                message.y,
                g?.battle?.flip
              )
              gameContainer.gameScene?.board?.displayText(
                coordinates[0],
                coordinates[1],
                t(message.text).toUpperCase(),
                true
              )
            }
          }
        )

        room.onDrop((code) => {
          if (code >= 1001 && code <= 1015) {
            // Between 1001 and 1015 - Abnormal socket shutdown
            if (connectionStatus === ConnectionStatus.CONNECTED) {
              dispatch(setConnectionStatus(ConnectionStatus.CONNECTION_LOST))
            }
          }
        })

        room.onReconnect(() => {
          dispatch(setConnectionStatus(ConnectionStatus.CONNECTED))
        })

        room.onLeave((code) => {
          const shouldGoToLobby = [
            CloseCodes.ROOM_DELETED,
            CloseCodes.USER_BANNED
          ].includes(code)
          if (shouldGoToLobby) {
            const errorMessage = CloseCodesMessages[code] as
              | ErrorMessage
              | undefined
            if (errorMessage) {
              dispatch(setErrorAlertMessage(t(`errors.${errorMessage}`)))
            }

            const scene = getGameScene()
            if (scene?.music) scene.music.destroy()
            navigate("/lobby")
          } else {
            dispatch(setConnectionStatus(ConnectionStatus.CONNECTION_FAILED))
          }
        })

        const $ = getStateCallbacks(room)
        const $state = $(room.state)

        $state.listen("gameMode", (mode) => {
          dispatch(setGameMode(mode))
        })

        $state.listen("roundTime", (value) => {
          dispatch(setRoundTime(value))
          const stageLevel = room.state.stageLevel ?? 0
          if (
            room.state.phase === GamePhaseState.PICK &&
            stageLevel in PVEStages === false &&
            value < 5 &&
            gameContainer.gameScene?.board &&
            !gameContainer.gameScene.board.portal
          ) {
            gameContainer.gameScene.board.addPortal()
          }
        })

        $state.listen("phase", (newPhase, previousPhase) => {
          if (gameContainer.game) {
            const g = getGameScene()
            if (g) {
              g.updatePhase(newPhase, previousPhase)
            }
          }
          dispatch(setPhase(newPhase))
        })

        $state.listen("stageLevel", (value) => {
          dispatch(setStageLevel(value))
        })

        $state.listen("noElo", (value) => {
          dispatch(setNoELO(value))
        })

        $state.listen("specialGameRule", (value) => {
          dispatch(setSpecialGameRule(value))
        })

        $state.additionalPokemons.onChange(() => {
          dispatch(
            setAdditionalPokemons(schemaValues(room.state.additionalPokemons))
          )
        })

        $state.simulations.onRemove(() => {
          gameContainer.resetSimulation()
        })

        $state.simulations.onAdd((simulation) => {
          gameContainer.initializeSimulation(simulation)
          const $simulation = $(simulation)

          $simulation.listen("weather", (value) => {
            dispatch(setWeather({ id: simulation.id, value: value }))
          })

          const teams = [Team.BLUE_TEAM, Team.RED_TEAM]
          teams.forEach((team) => {
            const $dpsMeter =
              team === Team.BLUE_TEAM
                ? $simulation.blueDpsMeter
                : $simulation.redDpsMeter
            $dpsMeter.onAdd((dps) => {
              dispatch(addDpsMeter({ value: dps, id: simulation.id, team }))
              const $dps = $(dps)
              const fields = [
                "id",
                "name",
                "physicalDamage",
                "specialDamage",
                "trueDamage",
                "heal",
                "shield",
                "physicalDamageReduced",
                "specialDamageReduced",
                "shieldDamageTaken"
              ] satisfies NonFunctionPropNames<IDps>[]
              fields.forEach((field) => {
                $dps.listen(field, (value) => {
                  dispatch(
                    changeDpsMeter({
                      id: dps.id,
                      team,
                      field: field,
                      value: value,
                      simulationId: simulation.id
                    })
                  )
                })
              })
            })

            $dpsMeter.onRemove((dps) => {
              dispatch(
                removeDpsMeter({
                  id: dps.id,
                  team,
                  simulationId: simulation.id
                })
              )
            })
          })
        })

        $state.players.onAdd((player) => {
          dispatch(addPlayer(player))
          gameContainer.initializePlayer(player)
          const $player = $(player)

          if (player.id == uid) {
            dispatch(setInterest(player.interest))
            dispatch(setMaxInterest(player.maxInterest))
            dispatch(setStreak(player.streak))
            dispatch(setShopLocked(player.shopLocked))
            dispatch(setShopFreeRolls(player.shopFreeRolls))
            dispatch(setEmotesUnlocked(player.emotesUnlocked))
            // Dispatch the CURRENT shop up-front, like the sibling fields above. $player.shop.onChange
            // below only conveys subsequent deltas, so a renderer that attaches to an already-populated
            // shop — a replay seek, or reconnecting to your own game in progress — would otherwise show a
            // blank shop. No-op for a fresh live game (shop is empty when you join).
            player.shop.forEach((pkm, index) =>
              dispatch(changeShop({ value: pkm, index }))
            )

            $player.listen("interest", (value) => {
              dispatch(setInterest(value))
            })
            $player.listen("maxInterest", (value) => {
              dispatch(setMaxInterest(value))
            })
            $player.shop.onChange((pkm: Pkm, index: number) => {
              dispatch(changeShop({ value: pkm, index }))
            })
            $player.listen("shopLocked", (value) => {
              dispatch(setShopLocked(value))
            })
            $player.listen("shopFreeRolls", (value) => {
              dispatch(setShopFreeRolls(value))
            })
            $player.listen("money", (value, previousValue) => {
              dispatch(setMoney(value))
              if (value - previousValue >= 30) {
                // show income toast for significant income only
                showMoneyToast(value - previousValue)
              }
            })
            $player.listen("streak", (value) => {
              dispatch(setStreak(value))
            })
            $player.choices.onChange(() => {
              dispatch(
                changePlayer({
                  id: player.id,
                  field: "choices",
                  value: schemaValues(player.choices)
                })
              )
            })
          }
          $player.listen("life", (value, previousValue) => {
            dispatch(setLife({ id: player.id, value: value }))
            if (
              value <= 0 &&
              value !== previousValue &&
              player.id === uid &&
              !spectate &&
              // In a replay this is the recorded POV dying mid-playback; showing the placing overlay would
              // sit it over the rest of the match (and its leave button runs the live flow). Suppress it,
              // mirroring the FINAL_RANK message guard. No-op for a live game.
              (room as { roomId?: string }).roomId !== "replay" &&
              finalRankVisibility === FinalRankVisibility.HIDDEN
            ) {
              setFinalRankVisibility(FinalRankVisibility.VISIBLE)
              getGameScene()?.input.keyboard?.removeAllListeners()
            }
          })
          $player.listen("experienceManager", (experienceManager) => {
            const $experienceManager = $(experienceManager)
            if (player.id === uid) {
              dispatch(updateExperienceManager(experienceManager))
              const fields = [
                "experience",
                "expNeeded",
                "level"
              ] satisfies NonFunctionPropNames<IExperienceManager>[]
              fields.forEach((field) => {
                $experienceManager.listen(field, (value) => {
                  dispatch(
                    updateExperienceManager({
                      ...experienceManager,
                      [field]: value
                    } as IExperienceManager)
                  )
                })
              })
            }
            $experienceManager.listen("level", (value) => {
              if (value > 1) {
                toast(
                  <p>
                    {t("level")} {value}
                  </p>,
                  {
                    containerId: player.rank.toString(),
                    className: "toast-level-up"
                  }
                )
              }
            })
          })
          $player.listen("loadingProgress", (value) => {
            dispatch(setLoadingProgress({ id: player.id, value: value }))
          })
          $player.listen("map", (newMap) => {
            if (player.id === store.getState().game.playerIdSpectated) {
              const gameScene = getGameScene()
              if (gameScene) {
                gameScene.setMap(newMap)
                const alreadyLoading = gameScene.load.isLoading()
                if (!alreadyLoading) {
                  gameScene.load.reset()
                }
                preloadMusic(gameScene, RegionDetails[newMap].music)
                gameScene.load.once("complete", () =>
                  playMusic(gameScene, RegionDetails[newMap].music)
                )
                if (!alreadyLoading) {
                  gameScene.load.start()
                }
              }
            }
            dispatch(
              changePlayer({ id: player.id, field: "map", value: newMap })
            )
          })

          $player.listen("spectatedPlayerId", (spectatedPlayerId) => {
            if (room?.state?.players) {
              const spectatedPlayer =
                room?.state?.players.get(spectatedPlayerId)
              // In a replay the recorded POV's spectatedPlayerId must NOT hijack the viewer's camera:
              // the viewer drives their own view (default POV + manual click, sticky across seeks), and
              // their pick is never yanked by what the recorded player happened to be scouting. Fights
              // still follow whoever is being watched via initializeSimulation (simulations.onAdd keys
              // on `this.player`). Live games keep following so a spectator tracks their own selection.
              // (A future "lock to player X's POV" mode would opt back into following the recorded view.)
              const isReplay =
                (room as { roomId?: string }).roomId === "replay"
              if (spectatedPlayer && player.id === uid && !isReplay) {
                gameContainer.setPlayer(spectatedPlayer)

                const simulation = room.state.simulations.get(
                  spectatedPlayer.simulationId
                )
                if (simulation) {
                  gameContainer.setSimulation(simulation)
                }
              }

              gameContainer.gameScene?.board?.updateScoutingAvatars()
            }
          })

          const fields = [
            "name",
            "avatar",
            "boardSize",
            "experienceManager",
            "money",
            "history",
            "life",
            "opponentId",
            "opponentName",
            "opponentAvatar",
            "opponentTitle",
            "rank",
            "regionalPokemons",
            "streak",
            "title",
            "eggChance",
            "goldenEggChance",
            "cellBattery",
            "gameStats",
            "scarvesItems",
            "fairyWands"
          ] satisfies NonFunctionPropNames<IPlayer>[]

          fields.forEach((field) => {
            $player.listen(field, (value) => {
              dispatch(
                changePlayer({ id: player.id, field: field, value: value })
              )
            })
          })

          $player.synergies.onChange(() => {
            dispatch(setSynergies({ id: player.id, value: player.synergies }))
          })

          $player.groundHoles.onChange((value) => {
            if (player.id === store.getState().game.playerIdSpectated) {
              const gameScene = getGameScene()
              if (
                gameScene?.board &&
                room.state.phase === GamePhaseState.PICK
              ) {
                gameScene.board.renderGroundHoles()
              }
            }
          })

          $player.listen("mulch", (value) => {
            dispatch(changePlayer({ id: player.id, field: "mulch", value }))
            getGameScene()?.board?.updateMulchCount()
          })
          $player.listen("mulchCap", (value) => {
            dispatch(changePlayer({ id: player.id, field: "mulchCap", value }))
            getGameScene()?.board?.updateMulchCount()
          })

          $player.wanderers.onAdd((wanderer: Wanderer) => {
            if (
              gameContainer.game &&
              player.id === store.getState().network.uid
            ) {
              const g = getGameScene()
              if (g && g.wandererManager) {
                g.wandererManager.addWanderer(wanderer)
              }
            }
          })
        })

        $state.players.onRemove((player) => {
          dispatch(removePlayer(player))
        })

        $state.spectators.onAdd((uid) => {
          gameContainer.initializeSpectactor(uid)
        })
      }

      bindRoom(room)

      // Re-attach entry for the replay viewer: re-point the persistent GameContainer at a fresh room,
      // re-register the minigame/state listeners + the per-room binding, and restart the scene against
      // it — WITHOUT destroying Phaser, so the loaded assets are reused and the seek is near-instant.
      // Only ever invoked from the replay viewer (reattachReplayRoom); never in a live game.
      reattachReplayRoomImpl = (
        newRoom: Room<GameState>,
        spectatedPlayerId?: string
      ) => {
        gameContainer.room = newRoom
        gameContainer.$ = getStateCallbacks(newRoom)
        gameContainer.initializeEvents()
        bindRoom(newRoom)
        // Build the scene directly on the board the viewer is watching (carried across the seek), so the
        // rebuild doesn't briefly show players[0] until begin()'s setPlayer() re-centres it.
        gameContainer.game?.scene.start("gameScene", {
          room: newRoom,
          spectate: gameContainer.spectate,
          spectatedPlayerId
        })
      }
    }
  }, [
    connected,
    connecting,
    initialized,
    room,
    dispatch,
    client,
    uid,
    spectatedPlayerId,
    connectToGame,
    leave
  ])

  return (
    <main id="game-wrapper" onContextMenu={(e) => e.preventDefault()}>
      <div id="game" ref={container}></div>
      {loaded ? (
        <>
          <MainSidebar page="game" leave={leave} leaveLabel={t("leave_game")} />
          <GameFinalRank
            rank={finalRank}
            hide={spectateTillTheEnd}
            leave={leave}
            visible={finalRankVisibility === FinalRankVisibility.VISIBLE}
          />
          {spectate ? <GameSpectatePlayerInfo /> : <GameShop />}
          <GameStageInfo />
          <GamePlayers click={(id: string) => playerClick(id)} />
          <GameSynergies />
          <GameChoice />
          <GameDpsMeter />
          <GameToasts />
          {currentGameEvent === GameEvent.EXPEDITIONS && !spectate && (
            <GameExpeditions />
          )}
        </>
      ) : (
        <GameLoadingScreen connectError={connectError} />
      )}
      <ConnectionStatusNotification />
    </main>
  )
}
