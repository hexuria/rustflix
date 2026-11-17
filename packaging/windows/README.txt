rustflix for Windows (x86_64)
=============================

Run rustflix.exe. Keep the "nsh" folder next to it: it holds the app's
interface. The folder can live anywhere, Program Files included: the app
writes nothing next to itself.

Requirements
------------
- Windows 10 (1809 or later) or Windows 11, 64-bit.
- Microsoft Edge WebView2 Runtime. Windows 11 has it, and Windows 10
  gets it with Microsoft Edge. If the app's video pages stay empty or
  the app reports that web views cannot show, install the "Evergreen
  Bootstrapper" from
  https://developer.microsoft.com/microsoft-edge/webview2/
- Media Foundation (part of Windows). Windows "N" editions need the
  Media Feature Pack (Settings > Apps > Optional features) for the
  app's own video player; without it, videos play in the source's page
  instead.

Where it keeps things
---------------------
- Settings, library, download list: %APPDATA%\com.hexuria.rustflix
- Image cache and web-page data:     %LOCALAPPDATA%\com.hexuria.rustflix
- Downloads (changeable in Settings): %USERPROFILE%\Downloads\rustflix

This build is not code-signed yet, so Windows SmartScreen may warn the
first time it starts ("More info" > "Run anyway").

rustflix is free software under the GNU General Public License v3.0.
