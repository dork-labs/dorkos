# PR #4060 retakes at 5348954af1

Light and at a 390 px phone width, plus 2a and 3b in dark. Made-up data, a throwaway data folder, the test runtime.

| Id | What it shows |
| --- | --- |
| 1b | Wi-Fi device: waiting, with the labelled match code |
| 1d | Wi-Fi device: a wrong code, kept in the field and selected |
| 2a | This computer: a request, with the match code and the Wi-Fi note inside the card |
| 2c | After Approve: only the code to type is left |
| 2d | **Web render of the Mac app's state**: the app's desktop check is answered by a made-up bridge. No Electron ran. |
| 2e | No passkey here: the line in the card, Approve disabled, Add a passkey |
| 2f | Approve failed: the error inside the card |
| 3a–3c | Sign-in checks: none, an away check plus one for this computer, adding an authenticator |
| 3d, 3e | Remove confirms; 3e is the last away check, with the destructive button |
| 3f | The away check is gone; only this computer's passkey is left |
| 4a–4c | A Wi-Fi device row on a phone, Run agents on, and its confirm |
| 5a | Another device's second step: the code is the main action, the passkey a link |

Known, fixed after this head: at 390 px, 2e's three buttons ran past the card. They now wrap.
