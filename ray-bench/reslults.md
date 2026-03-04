Ran on M1 Max CPU, 64GB Ram

1024:
+------+---------------------+-------------+-------------+------------+------------+------------+
| Main | IPC                 | Worker      |   1 workers |  4 workers |  8 workers | 12 workers |
+------+---------------------+-------------+-------------+------------+------------+------------+
| Node | Fn Call             | Node        |    222.5 ms |   223.1 ms |   226.7 ms |   225.5 ms |
| Node | Async Fn Call       | Node        |    223.1 ms |   228.4 ms |   222.8 ms |   227.8 ms |
| Node | postMessage         | Node Worker |    227.9 ms |    64.4 ms |    35.8 ms |    38.5 ms |
| Node | HTTP                | Node        |    239.7 ms |   236.9 ms |   242.3 ms |   231.6 ms |
| Node | postMessage         | Deno        |    219.3 ms |  60.6 ms * |  31.6 ms * |  32.0 ms * |
| Node | streams             | Deno        |    240.8 ms |    65.3 ms |    35.5 ms |    35.9 ms |
| Node | streams(reused)     | Deno        |    225.5 ms |    62.0 ms |    33.9 ms |    40.5 ms |
| Node | worker.eval         | Deno        |    226.8 ms |    61.2 ms |    39.6 ms |    39.2 ms |
| Node | worker.evalSync     | Deno        |    229.3 ms |   234.9 ms |   239.8 ms |   231.1 ms |
| Node | worker.handle       | Deno        |    222.3 ms |    60.9 ms |    36.3 ms |    40.0 ms |
| Node | postMessages(batch) | Deno        |  218.8 ms * |    61.2 ms |    32.9 ms |    42.6 ms |
| Node | worker.handle.apply | Deno        |    226.1 ms |    62.6 ms |    32.9 ms |    44.4 ms |
| Node | worker.eval(binary) | Deno        |    226.8 ms |    61.7 ms |    35.1 ms |    35.4 ms |
+------+---------------------+-------------+-------------+------------+------------+------------+

2048:
+------+---------------------+-------------+-------------+------------+------------+------------+
| Main | IPC                 | Worker      |   1 workers |  4 workers |  8 workers | 12 workers |
+------+---------------------+-------------+-------------+------------+------------+------------+
| Node | Fn Call             | Node        |    906.2 ms |   900.9 ms |   910.2 ms |   895.7 ms |
| Node | Async Fn Call       | Node        |    901.2 ms |   889.4 ms |   889.4 ms |   889.2 ms |
| Node | postMessage         | Node Worker |    908.6 ms |   244.2 ms |   135.4 ms |   163.4 ms |
| Node | HTTP                | Node        |    943.1 ms |   927.7 ms |   945.7 ms |   923.3 ms |
| Node | postMessage         | Deno        |    881.0 ms | 233.7 ms * |   124.5 ms |   135.4 ms |
| Node | streams             | Deno        |    907.9 ms |   246.7 ms |   133.2 ms |   143.3 ms |
| Node | streams(reused)     | Deno        |    897.4 ms |   234.7 ms |   124.1 ms |   144.4 ms |
| Node | worker.eval         | Deno        |    895.5 ms |   236.0 ms | 124.0 ms * | 125.1 ms * |
| Node | worker.evalSync     | Deno        |    896.8 ms |   906.8 ms |   925.6 ms |   921.3 ms |
| Node | worker.handle       | Deno        |  880.0 ms * |   234.8 ms |   124.8 ms |   133.1 ms |
| Node | postMessages(batch) | Deno        |    884.9 ms |   236.9 ms |   124.6 ms |   127.5 ms |
| Node | worker.handle.apply | Deno        |    897.2 ms |   237.9 ms |   124.8 ms |   126.5 ms |
| Node | worker.eval(binary) | Deno        |    891.8 ms |   236.9 ms |   127.9 ms |   143.0 ms |
+------+---------------------+-------------+-------------+------------+------------+------------+

4096:
+------+---------------------+-------------+-------------+------------+------------+------------+
| Main | IPC                 | Worker      |   1 workers |  4 workers |  8 workers | 12 workers |
+------+---------------------+-------------+-------------+------------+------------+------------+
| Node | Fn Call             | Node        |   3700.6 ms |  3592.5 ms |  3545.9 ms |  3545.2 ms |
| Node | Async Fn Call       | Node        |   3535.3 ms |  3531.1 ms |  3526.3 ms |  3658.5 ms |
| Node | postMessage         | Node Worker |   3646.1 ms |   973.6 ms |   501.2 ms |   555.0 ms |
| Node | HTTP                | Node        |   3739.5 ms |  3647.3 ms |  3647.2 ms |  3649.4 ms |
| Node | postMessage         | Deno        | 3513.3 ms * | 918.2 ms * |   482.9 ms |   476.6 ms |
| Node | streams             | Deno        |   3577.7 ms |   940.3 ms |   490.1 ms |   499.2 ms |
| Node | streams(reused)     | Deno        |   3536.5 ms |   921.8 ms |   486.8 ms |   486.4 ms |
| Node | worker.eval         | Deno        |   3525.4 ms |   926.7 ms |   487.0 ms |   536.2 ms |
| Node | worker.evalSync     | Deno        |   3556.4 ms |  3569.2 ms |  3620.6 ms |  3618.6 ms |
| Node | worker.handle       | Deno        |   3536.7 ms |   935.3 ms | 479.6 ms * |   491.0 ms |
| Node | postMessages(batch) | Deno        |   3538.4 ms |   929.3 ms |   482.9 ms |   484.4 ms |
| Node | worker.handle.apply | Deno        |   3592.2 ms |   938.1 ms |   481.9 ms | 455.9 ms * |
| Node | worker.eval(binary) | Deno        |   3562.4 ms |   934.2 ms |   497.8 ms |   488.5 ms |
+------+---------------------+-------------+-------------+------------+------------+------------+