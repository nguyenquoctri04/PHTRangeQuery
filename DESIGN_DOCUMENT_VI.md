# Tài liệu thiết kế hệ thống truy vấn khoảng P2P bằng PHT trên Chord DHT

## 1. Tổng quan

Hệ thống được thiết kế để xử lý truy vấn khoảng trong môi trường cơ sở dữ liệu phân tán ngang hàng. Dữ liệu thử nghiệm là các bản ghi cảm biến nhiệt độ gồm `id`, `sensorId`, `temperature` và `timestamp`. Thay vì dùng một database server tập trung, dữ liệu, chỉ mục và cấu trúc truy vấn được phân tán trên nhiều peer. Mỗi peer có thể nhận request, tham gia định tuyến, lưu dữ liệu cục bộ, xử lý truy vấn và giữ bản sao.

Mục tiêu chính là chứng minh hạn chế của Distributed Hash Table (DHT) đối với truy vấn khoảng và dùng Prefix Hash Tree (PHT) để khắc phục. DHT phù hợp với truy vấn chính xác theo khóa, nhưng phép băm làm mất thứ tự tự nhiên của dữ liệu. Vì vậy, các giá trị gần nhau như `20`, `21`, `22` có thể nằm ở các vị trí hoàn toàn khác nhau trên vòng định danh. Nếu chỉ dùng DHT, truy vấn `temperature BETWEEN 20 AND 25` phải được tách thành nhiều lookup chính xác. PHT bổ sung lớp chỉ mục theo tiền tố nhị phân để gom các giá trị gần nhau và giảm số lookup cần thực hiện.

## 2. Mục tiêu và phạm vi

Hệ thống có ba mục tiêu chính. Thứ nhất, dữ liệu phải được lưu và truy vấn theo mô hình peer-to-peer, không phụ thuộc vào cơ sở dữ liệu tập trung. Thứ hai, hệ thống phải so sánh được hai chiến lược truy vấn khoảng: individual DHT point lookups và PHT range query. Thứ ba, hệ thống cần có khả năng chịu lỗi cơ bản thông qua sao chép dữ liệu sang peer kế nhiệm.

Phạm vi hiện tại là prototype học thuật. Hệ thống chưa triển khai SQL query processor, transaction manager, concurrency control hoàn chỉnh, atomic commit protocol hoặc recovery log. Dữ liệu được lưu bằng file JSON cục bộ để dễ quan sát vị trí dữ liệu, chỉ mục và replica trên từng peer.

## 3. Kiến trúc tổng thể

Hệ thống chạy bằng Docker Compose với một bootstrap node và năm peer node:

```text
bootstrap-node :3000
peer1          :3001
peer2          :3002
peer3          :3003
peer4          :3004
peer5          :3005
```

Bootstrap node chỉ dùng để các peer đăng ký và join vào mạng ban đầu. Sau khi các peer đã tham gia Chord ring, routing và query processing được thực hiện trực tiếp giữa các peer. Người dùng có thể gửi request đến bất kỳ peer nào, ví dụ `peer1`, qua các endpoint `/insert`, `/query/pht`, `/query/points` và `/query/compare`. Peer nhận request sẽ dùng Chord để tìm peer sở hữu dữ liệu hoặc chỉ mục cần truy cập, nhờ đó cung cấp tính trong suốt vị trí ở mức API.

Mỗi peer lưu hai nhóm dữ liệu:

```text
storage/peerX/data.json
storage/peerX/pht.json
```

`data.json` lưu bản ghi chính, bản ghi replica và exact-temperature index. `pht.json` lưu PHT node chính và PHT node replica.

## 4. Chord DHT

Chord DHT được dùng làm lớp định tuyến và định vị dữ liệu. Hệ thống sử dụng vòng Chord 8-bit, tức không gian định danh có kích thước `2^8 = 256`. Các đối tượng được ánh xạ vào vòng bằng hàm băm:

```text
hash(peerId)                -> vị trí peer trên ring
hash(recordKey)             -> owner của bản ghi chính
hash("temp:" + temperature) -> owner của exact-temperature index
hash(prefix)                -> owner của PHT node
```

Mỗi peer duy trì `successor`, `predecessor` và finger table. Khi cần tìm owner của một khóa, peer gọi `find_successor(id)`. Nếu successor hiện tại chịu trách nhiệm cho định danh đó, kết quả được trả về ngay; nếu không, request được chuyển tiếp qua `closest_preceding_node(id)`. Các cơ chế `stabilize()`, `notify()` và `fix_fingers()` chạy định kỳ để duy trì Chord ring và cập nhật thông tin định tuyến.

## 5. Prefix Hash Tree

PHT được xây dựng trên thuộc tính `temperature`, với miền giá trị từ `-20` đến `50`. Mỗi nhiệt độ được dịch sang miền không âm rồi mã hóa thành chuỗi nhị phân 7 bit:

```text
shifted = temperature + 20
binary  = shifted.toString(2).padStart(7, "0")
```

Ví dụ, nhiệt độ `20` được chuyển thành `40`, sau đó mã hóa thành `0101000`. Các giá trị gần nhau có xu hướng chia sẻ tiền tố nhị phân, nên PHT có thể gom dữ liệu theo prefix. Root của PHT là prefix rỗng. Mỗi PHT node biểu diễn một khoảng giá trị tương ứng với prefix của node đó. Khi một leaf chứa nhiều hơn `MAX_BUCKET_SIZE = 10` bản ghi và prefix chưa đạt 7 bit, leaf được split thành hai node con `prefix + "0"` và `prefix + "1"`.

PHT không được lưu tập trung tại một peer. Owner của mỗi PHT node được xác định bằng:

```text
owner = find_successor(hash(prefix))
```

Do đó, sau khi split, các child node có thể thuộc về những peer khác nhau. Thiết kế này kết hợp Chord để định tuyến phân tán và PHT để bảo toàn thứ tự logic của thuộc tính nhiệt độ.

## 6. Chèn dữ liệu và truy vấn

Khi chèn một bản ghi, hệ thống tạo `recordKey`, tìm owner bằng Chord và lưu bản ghi tại peer đó. Đồng thời, hệ thống cập nhật exact-temperature index với khóa `temp:{temperature}` để phục vụ baseline. Sau đó, bản ghi được đưa vào PHT bằng cách mã hóa nhiệt độ thành binary key và đi từ root đến leaf phù hợp. Nếu leaf vượt quá ngưỡng bucket, node được split và các bản ghi được phân phối lại sang hai node con.

Baseline là individual DHT point lookups. Với khoảng `[min, max]`, hệ thống duyệt từng giá trị nhiệt độ nguyên trong khoảng, tạo khóa `temp:t`, tìm owner bằng Chord và lấy các bản ghi tương ứng từ exact-temperature index. Cách này đúng về kết quả nhưng chi phí tăng tuyến tính theo số điểm trong khoảng.

Chiến lược tối ưu là PHT range query. Truy vấn bắt đầu từ root PHT và chỉ đi tiếp vào các node có khoảng giá trị giao với khoảng cần tìm. Khi gặp leaf phù hợp, hệ thống lấy các bản ghi trong leaf và lọc lại bằng điều kiện `min <= temperature <= max`. Endpoint `/query/compare` chạy cả hai chiến lược và trả về các metric như số bản ghi, số peer liên hệ, số logical messages, số routing hops và latency.

## 7. Sao chép và chịu lỗi

Hệ thống dùng replication factor bằng 2. Mỗi bản ghi chính, entry của exact-temperature index và PHT node sau khi được lưu tại primary owner sẽ được sao chép sang successor peer của owner đó. Khi một primary PHT owner không phản hồi, truy vấn có thể thử đọc replica từ các peer ứng viên như successor, finger table hoặc danh sách peer đã biết.

Replication sang successor là lựa chọn cân bằng giữa tính sẵn sàng và chi phí. Full replication sẽ đơn giản hóa việc đọc khi lỗi xảy ra, nhưng làm tăng mạnh chi phí lưu trữ và cập nhật. Với mục tiêu demo học thuật, sao chép sang peer kế nhiệm đủ để minh họa khả năng chịu lỗi cơ bản mà không làm hệ thống quá phức tạp.

## 8. Đánh giá và giới hạn

Các metric chính gồm `resultsCount`, `peersContacted`, `messagesSent`, `queryHops`, `latencyMs` và `coveringPrefixes`. Kết quả thử nghiệm hiện tại cho thấy PHT trả về cùng số bản ghi với baseline nhưng giảm đáng kể số logical messages. Với khoảng hẹp `20 -> 25`, baseline dùng 12 messages còn PHT dùng 6 messages. Với khoảng rộng `-10 -> 40`, baseline dùng 102 messages còn PHT dùng 8 messages.

Tuy nhiên, PHT không luôn giảm mọi loại chi phí. Số `queryHops` của PHT có thể cao hơn vì mỗi prefix lookup vẫn phải định tuyến qua Chord, và owner của các prefix có thể phân tán trên nhiều vị trí khác nhau trong vòng. Trade-off chính là PHT giảm số lookup logic và logical messages, nhưng vẫn phụ thuộc vào chất lượng routing của Chord, trạng thái finger table và phân bố dữ liệu.

Giới hạn lớn nhất là storage JSON chưa phù hợp với ghi đồng thời cao và chưa có cơ chế nhất quán replica mạnh. Trong hệ thống thực tế, lớp lưu trữ nên được thay bằng SQLite, PostgreSQL, RocksDB hoặc storage engine có durability và concurrency tốt hơn. Nếu cần hỗ trợ workload cập nhật thường xuyên, hệ thống cũng cần bổ sung protocol đồng bộ replica, khóa phân tán hoặc transaction phù hợp.

## 9. Kết luận

Thiết kế hiện tại phù hợp với mục tiêu xây dựng hệ thống cơ sở dữ liệu phân tán P2P để xử lý truy vấn khoảng. Chord DHT cung cấp lớp định tuyến và định vị dữ liệu phân tán. Exact-temperature index tạo baseline rõ ràng cho lookup từng điểm. Prefix Hash Tree bổ sung khả năng truy vấn khoảng bằng cách bảo toàn thứ tự logic thông qua tiền tố nhị phân. Replication sang successor giúp cải thiện tính sẵn sàng ở mức cơ bản. Kết quả đánh giá cho thấy PHT trả về kết quả đúng như baseline nhưng giảm đáng kể logical messages, đặc biệt khi khoảng truy vấn bao phủ nhiều giá trị nhiệt độ.
