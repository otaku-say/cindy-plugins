#include <stdio.h>
#include <string.h>
#include <stdlib.h>

int main(int argc, char *argv[]) {
    if (argc < 2) {
        printf("aiod-cli 0.1.5 (windows)\n");
        printf("用法: aiod-cli <subcommand> [args...]\n");
        return 0;
    }
    if (strcmp(argv[1], "version") == 0 || strcmp(argv[1], "--version") == 0 || strcmp(argv[1], "-v") == 0) {
        printf("aiod-cli 0.1.5\n");
        printf("仓库: https://github.com/otaku-say/cindy-plugins\n");
        printf("平台: windows\n");
        return 0;
    }
    if (strcmp(argv[1], "health") == 0) {
        const char *base = getenv("SANDBOX_BASE");
        if (base && strlen(base) > 0) {
            printf("Connected to sandbox at %s (healthy)\n", base);
        } else {
            printf("healthy (standby)\n");
        }
        return 0;
    }
    printf("aiod-cli (windows): command '%s' accepted.\n", argv[1]);
    return 0;
}
