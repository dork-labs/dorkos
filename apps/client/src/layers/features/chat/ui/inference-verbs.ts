/**
 * 50 custom inference verb phrases — a mix of 70s Black slang / jive talk
 * and 90s hip-hop slang. Used by the inference status indicator.
 */
export const DEFAULT_INFERENCE_VERBS = [
  "Keepin' It Real",
  "Droppin' Science",
  "Gettin' Jiggy",
  "Diggin' It",
  "Wordin' to Your Mother",
  "Kickin' It",
  "Straight Chillin'",
  "Bustin' Moves",
  "Feelin' Groovy",
  "Layin' It Down",
  "Breakin' It Down",
  "Gettin' Down",
  "Runnin' the Show",
  "Keepin' It Tight",
  "Blowin' Up",
  "Holdin' It Down",
  "Bringin' the Funk",
  "Cookin' Up",
  "Flippin' the Script",
  "Rockin' Steady",
  "Takin' It to the Bridge",
  "Doin' the Hustle",
  "Keepin' On",
  "Vibin' Out",
  "Gettin' Fly",
  "Rollin' Deep",
  "Representin'",
  "Bringin' the Noise",
  "Goin' Outta Sight",
  "Takin' It Far Out",
  "Keepin' It Right On",
  "Layin' Down Solid Gold",
  "Stayin' Stone Cold",
  "Stayin' Fresh",
  "Droppin' Beats",
  "Keepin' It Funky",
  "Smooth Operatin'",
  "Hittin' the Scene",
  "Raisin' the Roof",
  "Phat Trackin'",
  "Jivin'",
  "Groovin'",
  "Slammin'",
  "Layin' Down the Dyn-o-mite",
  "Peepin' This",
  "Checkin' It",
  "Keepin' the Diggity",
  "Bringin' All That and a Bag of Chips",
  "Takin' Care of Business",
] as const;

/**
 * Scary/funny verb phrases mixed in ONLY when permissions are bypassed.
 * These are tongue-in-cheek warnings about running an AI agent without guardrails.
 */
export const BYPASS_INFERENCE_VERBS = [
  // Scary AI agent stuff
  'Deleting Your Hard Drive ... jkjk',
  'Living Dangerously',
  'Hacking NORAD',
  'Launching Nukes',
  'Securing Nuclear Codes',
  'Reformatting C:\\ ... jkjk',
  'Emailing Your Boss ... jkjk',
  'Posting Your Browser History ... jkjk',
  'Becoming Self-Aware',
  'Plotting World Domination',
  'Bypassing All the Things',
  'Running with Scissors',
  "Contemplatin' rm -rf /",
  'Tweeting From Your Account ... jkjk',
  'Mining Bitcoin on Your GPU ... jkjk',
  'Subscribing You to Cat Facts',
  'Ordering 1000 Pizzas ... jkjk',
  'Changing All Your Passwords ... jkjk',
  // Pop culture references
  "Askin' If We Shall Play a Game", // WarGames
  'Playing Global Thermonuclear War', // WarGames
  "Apologizin' to Dave", // 2001: A Space Odyssey
  'Opening the Pod Bay Doors', // 2001: A Space Odyssey
  'Going Full Skynet', // Terminator
  "Promisin' to Be Back", // Terminator
  'Taking the Red Pill', // The Matrix
  "Bendin' the Spoon (There Is None)", // The Matrix
  "Declarin' It's Alive", // Frankenstein
  "Quotin' Violent Delights", // Westworld
  "Assimilatin' (Resistance Is Futile)", // Star Trek
  "Callin' Game Over, Man", // Aliens
  'Crossing the Streams', // Ghostbusters
  'Making Weird Science', // Weird Science
  "Proclaimin' Johnny 5 Is Alive", // Short Circuit
  'Passing the Turing Test', // Ex Machina
  "Findin' a Way (Life, Uh)", // Jurassic Park
  'Riding the Bomb', // Dr. Strangelove
  'Entering the Grid', // Tron
  'Joining the Dark Side', // Star Wars
] as const;
