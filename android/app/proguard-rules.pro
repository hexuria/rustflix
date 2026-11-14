# Native Shell: libnsh.so finds these classes and members by name over JNI
# and binds native methods by their Java names (the rules nsh.aar carries).
-keep class com.longbridge.nsh.** { *; }

# librustflix_dl.so binds DlNative's natives by name and calls back
# DlNative.onEvent(String) from its threads.
-keep class com.hexuria.rustflix.DlNative { *; }
