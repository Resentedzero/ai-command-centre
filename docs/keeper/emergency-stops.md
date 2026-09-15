# Emergency stops

Keywords: stop, emergency, halt, pause, kill, freeze, lift

A stop refuses the next action at its scope: global, one agent version, one capability grant, one goal, one workflow run, or one run. It is checked before every invocation and again just before dispatch, so an in-flight call finishes but nothing after it starts.

A stopped run is finished for good; lifting a stop only allows new work. Pausing a workflow run is different: it holds the run until you resume it.
