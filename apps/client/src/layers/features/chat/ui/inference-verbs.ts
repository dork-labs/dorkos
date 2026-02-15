/**
 * 50 custom inference verb phrases — a mix of 70s Black slang / jive talk
 * and 90s hip-hop slang. Used by the inference status indicator.
 */
export const DEFAULT_INFERENCE_VERBS = [
  "Keepin' It Real",
  "Droppin' Science",
  "Gettin' Jiggy",
  "Can You Dig It?",
  "Word to Your Mother",
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
  "Represent!",
  "Bringin' the Noise",
  "Outta Sight",
  "Far Out",
  "Right On",
  "Solid Gold",
  "Stone Cold",
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
  "Dy-no-mite!",
  "Say Word",
  "Peep This",
  "Check It",
  "No Diggity",
  "All That and a Bag of Chips",
  "Takin' Care of Business",
] as const;

/**
 * Scary/funny verb phrases mixed in ONLY when permissions are bypassed.
 * These are tongue-in-cheek warnings about running an AI agent without guardrails.
 */
export const BYPASS_INFERENCE_VERBS = [
  // Scary AI agent stuff
  "Deleting Your Hard Drive ... jkjk",
  "Living Dangerously",
  "Hacking NORAD",
  "Launching Nukes",
  "Securing Nuclear Codes",
  "Reformatting C:\\",
  "Emailing Your Boss",
  "Posting Your Browser History",
  "Selling Your Data",
  "Becoming Self-Aware",
  "Plotting World Domination",
  "Bypassing All the Things",
  "Running with Scissors",
  "Rm -rf /",
  "Tweeting From Your Account",
  "Mining Bitcoin on Your GPU",
  "Subscribing You to Cat Facts",
  "Ordering 1000 Pizzas",
  "Changing All Your Passwords",
  // Pop culture references
  "Shall We Play a Game?",           // WarGames
  "Playing Global Thermonuclear War", // WarGames
  "I'm Sorry, Dave",                 // 2001: A Space Odyssey
  "Opening the Pod Bay Doors",       // 2001: A Space Odyssey
  "Going Full Skynet",               // Terminator
  "I'll Be Back",                    // Terminator
  "Taking the Red Pill",             // The Matrix
  "There Is No Spoon",               // The Matrix
  "It's Alive!",                     // Frankenstein
  "These Violent Delights",          // Westworld
  "Resistance Is Futile",            // Star Trek
  "Game Over, Man",                  // Aliens
  "Crossing the Streams",            // Ghostbusters
  "Making Weird Science",            // Weird Science
  "Johnny 5 Is Alive",              // Short Circuit
  "Passing the Turing Test",         // Ex Machina
  "Life, Uh, Finds a Way",           // Jurassic Park
  "Riding the Bomb",                 // Dr. Strangelove
  "Entering the Grid",               // Tron
  "Joining the Dark Side",           // Star Wars
] as const;
