# P2P Range Queries via Prefix Hash Trees

Đề tài #67: xây dựng hệ thống truy vấn khoảng trong mạng ngang hàng bằng
**Prefix Hash Tree (PHT)** trên nền **Chord Distributed Hash Table (DHT)**.

Hệ thống dùng dữ liệu nhiệt độ có giá trị từ -20 đến 50. Mục tiêu là so sánh:

- **Individual DHT point lookups**: tách range query thành nhiều lookup theo
  từng giá trị nhiệt độ.
- **PHT range query**: dùng prefix nhị phân để gom các giá trị gần nhau và chỉ
  truy cập các PHT leaf liên quan.

Không dùng database tập trung. Mỗi peer lưu dữ liệu cục bộ bằng JSON.

## 1. Kiến trúc hệ thống

Hệ thống chạy bằng Docker Compose gồm 1 bootstrap node và 5 peer node:

```text
bootstrap-node :3000
peer1          :3001
peer2          :3002
peer3          :3003
peer4          :3004
peer5          :3005
```

Bootstrap node chỉ dùng để các peer join vào hệ thống ban đầu. Sau khi join,
routing và query được thực hiện peer-to-peer giữa các peer.

Mỗi peer lưu dữ liệu tại:

```text
storage/peerX/data.json
storage/peerX/pht.json
```

Trong đó:

- `data.json`: primary records, replica records và exact-temperature index.
- `pht.json`: primary PHT nodes và replica PHT nodes.

## 2. Yêu cầu môi trường

Cần cài sẵn:

- Docker Desktop hoặc Docker Engine
- Docker Compose
- Node.js 18+ hoặc mới hơn
- npm

Kiểm tra nhanh:

```powershell
docker --version
docker compose version
node --version
npm --version
```

## 3. Cài đặt project

Clone repository:

```powershell
git clone <repository-url>
cd <repository-folder>
```

Cài dependencies cho script chạy ở thư mục gốc:

```powershell
npm install
```

Lưu ý: dependencies bên trong `bootstrap-node` và `peer` sẽ được cài trong quá
trình Docker build.

## 4. Chạy hệ thống

Build và khởi động toàn bộ node:

```powershell
docker compose up --build
```

Nếu muốn chạy ở background:

```powershell
docker compose up --build -d
```

Đợi vài giây để các peer join vào Chord ring. Sau đó kiểm tra peer:

```powershell
curl http://localhost:3001/health
curl http://localhost:3001/peer-info
curl http://localhost:3001/finger-table
```

## 5. Tạo và load dataset

Script `load:dataset` sẽ tự tạo `dataset.json` nếu file chưa tồn tại.

```powershell
npm run load:dataset
```

Mặc định dataset có 1000 records. Nếu muốn tạo dataset mới với số lượng khác:

```powershell
$env:DATASET_SIZE=2000
npm run generate:dataset
npm run load:dataset
```

Dataset có schema:

```json
{
  "id": 1,
  "sensorId": "S001",
  "temperature": 35,
  "timestamp": "2026-05-27T10:00:01.000Z"
}
```

Miền nhiệt độ được hỗ trợ:

```text
-20 -> 50
```

Mặc định `load:dataset` chạy tuần tự với `LOAD_CONCURRENCY=1` để tránh race
condition khi PHT split trên JSON storage. Nếu chỉ thử nghiệm nhanh, có thể
tăng concurrency:

```powershell
$env:LOAD_CONCURRENCY=5
npm run load:dataset
```

## 6. Chạy demo so sánh

Sau khi load dataset, chạy:

```powershell
npm run demo
```

Demo sẽ gọi 2 range query:

- Narrow range: `20 -> 25`
- Wide range: `-10 -> 40`

Kết quả được ghi vào:

```text
report-results.json
```

File này là output runtime, không cần push lên GitHub.

## 7. Các API chính

Các ví dụ dưới đây gọi qua `peer1`.

### Kiểm tra trạng thái

```powershell
curl http://localhost:3001/health
curl http://localhost:3001/peer-info
curl http://localhost:3001/finger-table
curl http://localhost:3001/metrics
```

### Tìm successor trên Chord ring

```powershell
curl "http://localhost:3001/find-successor?id=120"
```

### Insert một record

```powershell
curl -X POST http://localhost:3001/insert `
  -H "Content-Type: application/json" `
  -d "{\"id\":1001,\"sensorId\":\"S001\",\"temperature\":35,\"timestamp\":\"2026-05-27T10:00:00Z\"}"
```

### Query bằng PHT

```powershell
curl "http://localhost:3001/query/pht?min=20&max=25"
```

### Query baseline bằng individual point lookups

```powershell
curl "http://localhost:3001/query/points?min=20&max=25"
```

### So sánh PHT và baseline

```powershell
curl "http://localhost:3001/query/compare?min=20&max=25"
curl "http://localhost:3001/query/compare?min=-10&max=40"
```

### Xem PHT nodes trên một peer

```powershell
curl http://localhost:3001/pht
```

## 8. Prefix Hash Tree

PHT mã hóa nhiệt độ thành chuỗi nhị phân 7 bit:

```js
shifted = temperature + 20;
binary = shifted.toString(2).padStart(7, "0");
```

Ví dụ:

```text
temperature = 20
shifted     = 40
binary      = 0101000
```

Khi một leaf node có nhiều hơn `MAX_BUCKET_SIZE = 10` records, node đó được
split thành:

```text
prefix + "0"
prefix + "1"
```

Owner của mỗi PHT node được xác định bằng:

```text
find_successor(hash(prefix))
```

## 9. Failure demo

Hệ thống có replication factor = 2. Primary record, temperature index và PHT
node được replicate sang successor peer.

Chạy demo hướng dẫn failure:

```powershell
npm run demo:failure
```

Script sẽ in kết quả trước lỗi và hướng dẫn dừng một peer, ví dụ:

```powershell
docker stop peer3
```

Sau đó có thể query lại:

```powershell
curl "http://localhost:3001/query/pht?min=20&max=25"
```

Kỳ vọng: số lượng kết quả vẫn giữ nguyên nếu dữ liệu liên quan đã được replicate.

## 10. Dừng và dọn môi trường

Dừng container:

```powershell
docker compose down
```

Dừng và xóa volume/network liên quan:

```powershell
docker compose down -v
```

Nếu muốn chạy lại từ đầu, xóa dữ liệu runtime trong `storage/peer*` rồi load lại
dataset.

## 11. Cấu trúc thư mục

```text
.
├── bootstrap-node/        # Bootstrap service
├── peer/                  # Peer service: Chord, PHT, query, storage
├── scripts/               # Dataset, load, demo, failure demo
├── storage/               # Runtime local JSON storage, không cần push
├── docker-compose.yml
├── package.json
├── REPORT.md
└── README.md
```

## 12. Ghi chú khi push GitHub

Các file/thư mục runtime như `node_modules`, `storage`, `dataset.json`,
`report-results.json`, logs và cache đã được loại trừ trong `.gitignore`.

Các file nên push:

- Source code trong `bootstrap-node`, `peer`, `scripts`
- `docker-compose.yml`
- `package.json`
- `README.md`
- `REPORT.md`

