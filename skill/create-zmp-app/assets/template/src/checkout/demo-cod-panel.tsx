import { useMemo, useState } from "react";
import { Button } from "zmp-ui";
import { catalog } from "../data/catalog";
import { formatPrice } from "../utils/format";
import type { DemoCodCartItem } from "./template-cart-adapter";

interface DemoCodPanelProps {
  items: DemoCodCartItem[];
}

interface DemoCodOrder {
  orderId: string;
  createdAt: string;
  orderStatus: "processing";
  paymentStatus: "unpaid";
  paymentMethod: "COD";
  amount: number;
  items: DemoCodCartItem[];
}

const STORAGE_KEY = "zmp-demo-cod-latest-order-v1";

function createOrderId(): string {
  const time = Date.now().toString(36).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DEMO-COD-${time}-${suffix}`;
}

function saveOrder(order: DemoCodOrder): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // The visible result remains usable when storage is unavailable.
  }
}

function createdAtCopy(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function DemoCodPanel({ items }: DemoCodPanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [order, setOrder] = useState<DemoCodOrder>();
  const amount = useMemo(
    () => items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    [items],
  );

  const confirmOrder = () => {
    const next: DemoCodOrder = {
      orderId: createOrderId(),
      createdAt: new Date().toISOString(),
      orderStatus: "processing",
      paymentStatus: "unpaid",
      paymentMethod: "COD",
      amount,
      items,
    };
    saveOrder(next);
    setOrder(next);
    setConfirmOpen(false);
  };

  return (
    <div className="checkout-panel checkout-demo-panel" data-testid="checkout-demo-panel">
      <Button
        fullWidth
        data-testid="checkout-submit"
        disabled={items.length === 0}
        onClick={() => setConfirmOpen(true)}
      >
        Đặt hàng
      </Button>

      {order && (
        <div
          className="checkout-demo-success"
          data-testid="checkout-demo-order-success"
          data-result="order-placed"
          role="status"
        >
          <strong>Đặt hàng thành công</strong>
          <span>Đơn COD đang xử lý và chưa thanh toán.</span>
          <button
            type="button"
            className="checkout-demo-link"
            data-testid="checkout-demo-view-order"
            onClick={() => setDetailOpen(true)}
          >
            Xem chi tiết đơn hàng
          </button>
        </div>
      )}

      <p className="checkout-backend-note" data-testid="checkout-backend-required">
        Bản Development mô phỏng COD trên thiết bị này, không thu tiền thật và
        không thay thế dữ liệu đơn hàng ở backend.
      </p>

      {confirmOpen && (
        <div
          className="checkout-demo-overlay"
          data-testid="checkout-demo-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="checkout-demo-title"
        >
          <section className="checkout-demo-sheet">
            <header className="checkout-demo-sheet-header">
              <h2 id="checkout-demo-title">Xác nhận thanh toán</h2>
              <button type="button" onClick={() => setConfirmOpen(false)}>Đóng</button>
            </header>
            <div className="checkout-demo-summary">
              <span className="checkout-demo-badge" data-testid="checkout-demo-badge">BẢN DEMO</span>
              <strong>{catalog.appTitle}</strong>
              <span className="checkout-demo-amount">{formatPrice(amount)}</span>
              <span>Đặt đơn tại {catalog.appTitle}</span>
            </div>
            <div className="checkout-demo-method">
              <span aria-hidden="true">💵</span>
              <span>
                <small>Kênh thanh toán</small>
                <strong>Thanh toán khi nhận hàng</strong>
              </span>
              <span aria-hidden="true">✓</span>
            </div>
            <footer className="checkout-demo-actions">
              <button type="button" onClick={() => setConfirmOpen(false)}>Quay lại</button>
              <button
                type="button"
                className="checkout-demo-primary"
                data-testid="checkout-demo-confirm"
                onClick={confirmOrder}
              >
                Xác nhận
              </button>
            </footer>
          </section>
        </div>
      )}

      {detailOpen && order && (
        <div
          className="checkout-demo-overlay"
          data-testid="checkout-demo-order-detail"
          role="dialog"
          aria-modal="true"
          aria-labelledby="checkout-demo-detail-title"
        >
          <section className="checkout-demo-sheet checkout-demo-detail">
            <header className="checkout-demo-sheet-header">
              <h2 id="checkout-demo-detail-title">Thông tin đặt hàng</h2>
              <button type="button" onClick={() => setDetailOpen(false)}>Đóng</button>
            </header>
            <span className="checkout-demo-badge" data-testid="checkout-demo-badge">BẢN DEMO</span>
            <div className="checkout-demo-statuses">
              <span data-testid="checkout-demo-order-status" data-order-status="processing">Đang xử lý</span>
              <span data-testid="checkout-demo-payment-status" data-payment-status="unpaid">Chưa thanh toán</span>
            </div>
            <dl className="checkout-demo-meta">
              <div><dt>Mã đơn hàng</dt><dd>{order.orderId}</dd></div>
              <div><dt>Ngày đặt hàng</dt><dd>{createdAtCopy(order.createdAt)}</dd></div>
              <div><dt>Phương thức thanh toán</dt><dd>COD</dd></div>
            </dl>
            <div className="checkout-demo-products">
              <h3>Sản phẩm</h3>
              {order.items.map((item) => (
                <div className="checkout-demo-product" key={item.productId}>
                  <span style={{ backgroundColor: item.accent }} aria-hidden="true">{item.emoji}</span>
                  <span><strong>{item.name}</strong><small>×{item.quantity}</small></span>
                  <strong>{formatPrice(item.unitPrice * item.quantity)}</strong>
                </div>
              ))}
            </div>
            <p className="checkout-demo-total"><span>Tổng cộng</span><strong>{formatPrice(order.amount)}</strong></p>
            <p className="checkout-demo-disclaimer">
              Đơn demo chỉ lưu trên thiết bị này, không phải chứng từ thanh toán hay dữ liệu kế toán.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
